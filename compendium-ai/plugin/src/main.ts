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

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new CompendiumSettingTab(this.app, this));

    this.statusBar = new StatusBar(this.addStatusBarItem(), this.app);
    this.removeCursorStyles = injectCursorStyles();

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
    this.unsubscribe = this.registry.onStatusChange((status, count, errors) => {
      this.statusBar?.render(status, count, errors);
    });
    const baselines = new BaselineStore(
      () => this.settings.baselines,
      () => this.saveSettings(),
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
    this.statusBar?.render('idle', 0, []);
  }
}
