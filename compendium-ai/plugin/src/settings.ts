// Plugin settings: server URL and auth token. Validated on save against the
// shared Zod schema so typos don't silently wedge the sync loop.

import { PluginSettingTab, Setting, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type CompendiumPlugin from './main';

export type CompendiumSettings = {
  serverUrl: string;
  authToken: string;
};

export const DEFAULT_SETTINGS: CompendiumSettings = {
  serverUrl: '',
  authToken: '',
};

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
            this.plugin.settings.serverUrl = value.trim().replace(/\/+$/, '');
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
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

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
