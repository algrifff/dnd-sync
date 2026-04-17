// Plugin settings: server URL and auth token. Validated on save against the
// shared Zod schema so typos don't silently wedge the sync loop.

import { PluginSettingTab, Setting, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type CompendiumPlugin from './main';

export type CompendiumSettings = {
  serverUrl: string;
  authToken: string;
  /** Shown above your cursor when live-editing with friends. */
  displayName: string;
  /** Hex '#rrggbb' for your cursor + selection highlight. Empty = derived from name. */
  displayColor: string;
};

export const DEFAULT_SETTINGS: CompendiumSettings = {
  serverUrl: '',
  authToken: '',
  displayName: '',
  displayColor: '',
};

/**
 * Cleans whatever the user pasted into the server URL field. Handles:
 * - surrounding whitespace
 * - ws:// or wss:// schemes (swap to http(s)://)
 * - trailing slashes
 * - trailing /api/..., /install/..., /sync/... (friends sometimes paste a full URL)
 */
export function normalizeServerUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  s = s.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
  // If no scheme, default to https.
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  // Strip any trailing path segments beyond the origin.
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`.replace(/\/+$/, '');
  } catch {
    return s.replace(/\/+$/, '');
  }
}

/**
 * Cleans the auth-token field. Handles tokens that got pasted with
 * surrounding whitespace, a `Bearer ` prefix, or query-string noise
 * like `&friend=...` that leaked in from an earlier bug.
 */
export function normalizeAuthToken(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^Bearer\s+/i, '');
  // Stop at first space or '&' — a correct token is alphanumerics only.
  s = s.split(/[&\s?]/)[0] ?? '';
  return s;
}

export class CompendiumSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: CompendiumPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Compendium' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your Compendium server — e.g. https://compendium.up.railway.app')
      .addText((text) =>
        text
          .setPlaceholder('https://compendium.up.railway.app')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = normalizeServerUrl(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auth token')
      .setDesc('Paste the token your DM gave you.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('paste your token')
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = normalizeAuthToken(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Display name')
      .setDesc('Shown on your cursor when you live-edit a note with a friend.')
      .addText((text) =>
        text
          .setPlaceholder('Alex')
          .setValue(this.plugin.settings.displayName)
          .onChange(async (value) => {
            this.plugin.settings.displayName = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Cursor colour')
      .setDesc('Your cursor + selection highlight. Reset to derive automatically from your name.')
      .addColorPicker((picker) =>
        picker
          .setValue(this.plugin.settings.displayColor || '#e67e22')
          .onChange(async (value) => {
            this.plugin.settings.displayColor = value;
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton((btn) =>
        btn
          .setIcon('reset')
          .setTooltip('Auto (derived from name)')
          .onClick(async () => {
            this.plugin.settings.displayColor = '';
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Connection')
      .setDesc('Reconnect after changing settings.')
      .addButton((btn) =>
        btn.setButtonText('Reconnect').onClick(async () => {
          await this.plugin.reconnect();
          new Notice('Compendium: reconnected');
        }),
      );
  }
}
