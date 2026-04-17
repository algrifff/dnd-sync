// Plugin entry point. Obsidian instantiates this class on load, calls
// onload(), and calls onunload() when the plugin is disabled or reloaded.

import { Notice, Plugin } from 'obsidian';
import {
  CompendiumSettingTab,
  DEFAULT_SETTINGS,
  type CompendiumSettings,
} from './settings';
import { DocRegistry } from './sync/docRegistry';
import { FileMirror } from './sync/fileMirror';
import { StatusBar } from './ui/statusBar';

export default class CompendiumPlugin extends Plugin {
  settings: CompendiumSettings = DEFAULT_SETTINGS;
  private registry: DocRegistry | null = null;
  private mirror: FileMirror | null = null;
  private statusBar: StatusBar | null = null;
  private unsubscribe: (() => void) | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new CompendiumSettingTab(this.app, this));

    this.statusBar = new StatusBar(this.addStatusBarItem(), this.app);

    if (!this.settings.serverUrl || !this.settings.authToken) {
      new Notice('Compendium: open Settings → Community plugins → Compendium to configure.');
      return;
    }
    this.startSync();
  }

  override async onunload(): Promise<void> {
    this.stopSync();
    this.statusBar?.dispose();
    this.statusBar = null;
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<CompendiumSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async reconnect(): Promise<void> {
    this.stopSync();
    if (this.settings.serverUrl && this.settings.authToken) this.startSync();
  }

  private startSync(): void {
    this.registry = new DocRegistry({
      serverUrl: this.settings.serverUrl,
      authToken: this.settings.authToken,
    });
    this.unsubscribe = this.registry.onStatusChange((status, count) => {
      this.statusBar?.render(status, count);
    });
    this.mirror = new FileMirror(this.app, this.registry);
    // Wait for the Obsidian layout to finish loading before enumerating —
    // otherwise vault.getMarkdownFiles() can return an empty list on first boot.
    this.app.workspace.onLayoutReady(() => {
      this.mirror?.start();
    });
  }

  private stopSync(): void {
    this.mirror?.stop();
    this.mirror = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.registry?.destroyAll();
    this.registry = null;
    this.statusBar?.render('idle', 0);
  }
}
