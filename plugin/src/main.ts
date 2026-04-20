// Plugin entry point. Obsidian instantiates this class on load, calls
// onload(), and calls onunload() when the plugin is disabled or reloaded.

import { Notice, Plugin } from 'obsidian';
import {
  CompendiumSettingTab,
  DEFAULT_SETTINGS,
  normalizeAuthToken,
  normalizeServerUrl,
  type CompendiumSettings,
} from './settings';
import { CmBinding } from './editor/cmBinding';
import { injectCursorStyles } from './editor/cursorStyles';
import { makeIdentity } from './editor/identity';
import { BaselineStore } from './sync/baselines';
import { BinarySync } from './sync/binarySync';
import { DocRegistry } from './sync/docRegistry';
import { FileMirror } from './sync/fileMirror';
import { PluginUpdater } from './sync/updater';
import { VaultConfigSync } from './sync/vaultConfigSync';
import { StatusBar } from './ui/statusBar';

const EMPTY_COUNTS = {
  total: 0,
  handshaking: 0,
  syncing: 0,
  live: 0,
  disconnected: 0,
  totalReceived: 0,
  totalSent: 0,
} as const;

export default class CompendiumPlugin extends Plugin {
  settings: CompendiumSettings = DEFAULT_SETTINGS;
  private registry: DocRegistry | null = null;
  private mirror: FileMirror | null = null;
  private binary: BinarySync | null = null;
  private vaultConfig: VaultConfigSync | null = null;
  private cmBinding: CmBinding | null = null;
  private updater: PluginUpdater | null = null;
  private statusBar: StatusBar | null = null;
  private unsubscribe: (() => void) | null = null;
  private removeCursorStyles: (() => void) | null = null;
  /** Interval that re-emits the registry's current state so the tooltip
   *  traffic counters refresh while nothing structural changes. */
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new CompendiumSettingTab(this.app, this));

    this.statusBar = new StatusBar(this.addStatusBarItem(), this.app);
    this.removeCursorStyles = injectCursorStyles();

    this.addCommand({
      id: 'compendium-copy-sync-report',
      name: 'Compendium: Copy sync report',
      callback: () => void this.copySyncReport(),
    });

    if (!this.settings.serverUrl || !this.settings.authToken) {
      new Notice('Compendium: open Settings → Community plugins → Compendium to configure.');
      return;
    }
    this.startSync();
  }

  override async onunload(): Promise<void> {
    this.stopSync();
    this.removeCursorStyles?.();
    this.removeCursorStyles = null;
    this.statusBar?.dispose();
    this.statusBar = null;
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<CompendiumSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };

    // Guard against corrupted or legacy data.json where baselines was null
    // or the wrong shape — treat anything non-object as empty.
    if (
      !this.settings.baselines ||
      typeof this.settings.baselines !== 'object' ||
      Array.isArray(this.settings.baselines)
    ) {
      this.settings.baselines = {};
    }

    // Self-heal messy values from past-me's bugs or human paste mistakes.
    const healedUrl = normalizeServerUrl(this.settings.serverUrl);
    const healedToken = normalizeAuthToken(this.settings.authToken);
    if (healedUrl !== this.settings.serverUrl || healedToken !== this.settings.authToken) {
      this.settings.serverUrl = healedUrl;
      this.settings.authToken = healedToken;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Push display-name changes into any active cursor bindings so peers
    // see the new label without a reconnect.
    this.cmBinding?.updateIdentity(makeIdentity(this.settings.displayName, this.settings.displayColor));
  }

  async reconnect(): Promise<void> {
    const desired = {
      serverUrl: this.settings.serverUrl,
      authToken: this.settings.authToken,
    };

    // If we're already running with the same config, don't tear down —
    // that would abruptly close every WebSocket (Chrome logs one red
    // 'failed' line per provider). y-websocket auto-reconnects on real
    // drops, so a manual reconnect when nothing changed is noise.
    if (this.registry) {
      const current = this.registry.getConfig();
      if (current.serverUrl === desired.serverUrl && current.authToken === desired.authToken) {
        new Notice('Compendium: already connected with these settings.');
        return;
      }
    }

    this.stopSync();
    if (desired.serverUrl && desired.authToken) this.startSync();
    new Notice('Compendium: reconnected.');
  }

  private startSync(): void {
    const cfg = {
      serverUrl: this.settings.serverUrl,
      authToken: this.settings.authToken,
    };
    this.registry = new DocRegistry(cfg);
    this.unsubscribe = this.registry.onStatusChange((status, counts, errors) => {
      this.statusBar?.render(status, counts, errors);
    });
    // Refresh the tooltip every 2s so update counters reflect live traffic
    // even when no structural state change is happening.
    this.tickHandle = setInterval(() => {
      const reg = this.registry;
      if (!reg) return;
      const snap = reg.snapshot();
      this.statusBar?.render(snap.status, snap.counts, snap.errors);
    }, 2000);
    const baselines = new BaselineStore(
      () => this.settings.baselines,
      // Persist directly via saveData to skip the display-identity side
      // effect in saveSettings(). Baseline writes happen on every reconcile
      // and every modified keystroke batch; we don't want to rebroadcast
      // awareness every time a hash changes.
      () => this.saveData(this.settings),
    );
    this.mirror = new FileMirror(
      this.app,
      this.registry,
      cfg,
      baselines,
      () => this.settings.displayName,
    );
    this.binary = new BinarySync(this.app, cfg, this.registry);
    this.vaultConfig = new VaultConfigSync(this.app, cfg);
    this.cmBinding = new CmBinding(this.app, this.registry, makeIdentity(this.settings.displayName, this.settings.displayColor));
    this.updater = new PluginUpdater(this.app, this, cfg);
    // Wait for the Obsidian layout to finish loading before enumerating —
    // otherwise vault.getMarkdownFiles() can return an empty list on first boot.
    this.app.workspace.onLayoutReady(() => {
      void this.mirror?.start();
      void this.binary?.start();
      this.vaultConfig?.start();
      this.cmBinding?.start();
      this.updater?.start();
    });
  }

  private stopSync(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.updater?.stop();
    this.updater = null;
    this.cmBinding?.stop();
    this.cmBinding = null;
    this.vaultConfig?.stop();
    this.vaultConfig = null;
    this.binary?.stop();
    this.binary = null;
    this.mirror?.stop();
    this.mirror = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.registry?.destroyAll();
    this.registry = null;
    this.statusBar?.render('idle', { ...EMPTY_COUNTS }, []);
  }

  /** Build a diagnostic report and copy it to the clipboard so the user
   *  can paste it back for troubleshooting. Contains only per-doc sync
   *  state and error strings — no content, no token. */
  private async copySyncReport(): Promise<void> {
    if (!this.registry) {
      new Notice('Compendium: not running. Configure in settings first.');
      return;
    }
    const snap = this.registry.snapshot();
    const docs = this.registry.report();
    const lines: string[] = [];
    lines.push(`Compendium sync report — ${new Date().toISOString()}`);
    lines.push(`Status: ${snap.status}`);
    lines.push(
      `Counts: ${snap.counts.live} live / ${snap.counts.syncing} syncing / ${snap.counts.handshaking} handshaking / ${snap.counts.disconnected} disconnected (total ${snap.counts.total})`,
    );
    lines.push(`Traffic: ${snap.counts.totalSent} sent · ${snap.counts.totalReceived} received`);
    if (snap.errors.length > 0) {
      lines.push('');
      lines.push('Errors:');
      for (const e of snap.errors) lines.push('  · ' + e);
    }
    lines.push('');
    lines.push('Per-doc:');
    const sorted = [...docs].sort((a, b) => {
      const order = { disconnected: 0, handshaking: 1, syncing: 2, live: 3 };
      const d = order[a.phase] - order[b.phase];
      return d !== 0 ? d : a.path.localeCompare(b.path);
    });
    for (const d of sorted) {
      const since = (t: number | null): string =>
        t === null ? 'never' : `${Math.round((Date.now() - t) / 1000)}s ago`;
      lines.push(
        `  [${d.phase}] ${d.path}  sent=${d.sent} recv=${d.received}  lastSent=${since(d.lastSentAt)} lastRecv=${since(d.lastReceivedAt)}${d.lastError ? '  err=' + d.lastError : ''}`,
      );
    }
    const report = lines.join('\n');
    try {
      await navigator.clipboard.writeText(report);
      new Notice(`Compendium: sync report copied (${docs.length} docs).`);
    } catch {
      console.info('[compendium] sync report:\n' + report);
      new Notice('Compendium: sync report written to console (clipboard blocked).');
    }
  }
}
