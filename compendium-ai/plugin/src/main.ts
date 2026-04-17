// Plugin entry point. Obsidian instantiates this class on load, calls
// onload(), and calls onunload() when the plugin is disabled or reloaded.

import { Plugin } from 'obsidian';
import {
  CompendiumSettingTab,
  DEFAULT_SETTINGS,
  type CompendiumSettings,
} from './settings';

export default class CompendiumPlugin extends Plugin {
  settings: CompendiumSettings = DEFAULT_SETTINGS;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new CompendiumSettingTab(this.app, this));
    // Sync wiring lands in Milestone 4.2+.
    console.log('[compendium] plugin loaded');
  }

  override async onunload(): Promise<void> {
    console.log('[compendium] plugin unloaded');
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<CompendiumSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Called from the settings pane. Real wiring lands in 4.2. */
  async reconnect(): Promise<void> {
    // no-op in 4.1; reconnect logic wired in with the provider.
  }
}
