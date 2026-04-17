// Plugin settings — server URL, auth token, and display preferences.
// All free-form input runs through normalize* helpers so paste mishaps
// (trailing whitespace, wrong scheme, leftover query string) self-correct.

import { Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';
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
 * Cleans whatever the user pasted into the server URL field. Handles
 * surrounding whitespace, ws(s):// → http(s)://, missing schemes,
 * trailing slashes, and accidental full-path URLs (/api/..., /install/...)
 * by keeping only protocol + host.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const withScheme = (() => {
    const swapped = trimmed.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    return /^https?:\/\//i.test(swapped) ? swapped : `https://${swapped}`;
  })();

  try {
    const parsed = new URL(withScheme);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return withScheme.replace(/\/+$/, '');
  }
}

/**
 * Cleans the auth token. Strips `Bearer ` prefixes, whitespace, and any
 * query-string suffix like `&friend=<uuid>` that leaked in from an
 * earlier installer bug.
 */
export function normalizeAuthToken(raw: string): string {
  const withoutPrefix = raw.trim().replace(/^Bearer\s+/i, '');
  return withoutPrefix.split(/[&\s?]/)[0] ?? '';
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

    this.renderMissingConfigBanner(containerEl);
    this.renderConnectionSettings(containerEl);
    this.renderIdentitySettings(containerEl);
    this.renderConnectionActions(containerEl);
  }

  // ── Rendering helpers ────────────────────────────────────────────────

  private renderMissingConfigBanner(root: HTMLElement): void {
    const { serverUrl, authToken } = this.plugin.settings;
    if (serverUrl && authToken) return;

    const missing: string[] = [];
    if (!serverUrl) missing.push('server URL');
    if (!authToken) missing.push('auth token');

    const banner = root.createDiv();
    banner.style.cssText = [
      'border: 1px solid var(--text-error)',
      'background: rgba(255, 100, 100, 0.08)',
      'border-radius: 6px',
      'padding: 10px 12px',
      'margin: 0 0 12px 0',
    ].join(';');
    banner.createEl('strong', { text: 'Compendium is not configured.' });
    banner.createEl('p', {
      text: `Ask your DM for the ${missing.join(' and ')} and paste below. They can copy these from the admin dashboard under "Friend installers" → "Manual setup".`,
      attr: { style: 'margin: 6px 0 0 0; font-size: 0.85em;' },
    });
  }

  private renderConnectionSettings(root: HTMLElement): void {
    new Setting(root)
      .setName('Server URL')
      .setDesc('Your DM\'s Compendium server — e.g. https://compendium.up.railway.app')
      .addText((text) =>
        text
          .setPlaceholder('https://compendium.up.railway.app')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = normalizeServerUrl(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName('Auth token')
      .setDesc('The long random string your DM shared with you.')
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
  }

  private renderIdentitySettings(root: HTMLElement): void {
    new Setting(root)
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

    new Setting(root)
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
  }

  private renderConnectionActions(root: HTMLElement): void {
    new Setting(root)
      .setName('Test connection')
      .setDesc('Ping your server to confirm the URL + token are correct before saving.')
      .addButton((btn) =>
        btn
          .setButtonText('Test')
          .onClick(async () => {
            await this.runConnectionTest(btn);
          }),
      );

    new Setting(root)
      .setName('Reconnect')
      .setDesc('Tear down the current connection and reconnect with the saved settings.')
      .addButton((btn) =>
        btn.setButtonText('Reconnect').onClick(async () => {
          await this.plugin.reconnect();
          new Notice('Compendium: reconnected');
        }),
      );
  }

  private async runConnectionTest(btn: { setButtonText: (s: string) => void }): Promise<void> {
    const { serverUrl, authToken } = this.plugin.settings;
    if (!serverUrl || !authToken) {
      new Notice('Compendium: fill in both fields first.');
      return;
    }
    btn.setButtonText('Testing…');
    try {
      const res = await requestUrl({
        url: `${serverUrl}/api/inventory`,
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}` },
        throw: false,
      });
      if (res.status === 200) {
        new Notice('Compendium: connection OK ✓');
      } else if (res.status === 401) {
        new Notice('Compendium: token rejected (401). Ask your DM for a fresh one.');
      } else {
        new Notice(`Compendium: unexpected status ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      new Notice(`Compendium: couldn't reach server (${msg})`);
    } finally {
      btn.setButtonText('Test');
    }
  }
}
