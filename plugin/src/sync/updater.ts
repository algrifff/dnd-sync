// Self-updater. Periodically asks the server for the current main.js hash
// and, if different from our own, downloads the new bundle and writes it
// into .obsidian/plugins/<id>/main.js. Takes effect on the next Obsidian
// reload (Ctrl/Cmd+R or restart) because Obsidian caches plugin modules
// for the lifetime of the session.

import { Notice } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import { fetchPluginBundle, fetchPluginVersion, type HttpConfig } from './http';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const INITIAL_DELAY_MS = 10 * 1000; // 10 s after plugin load

export class PluginUpdater {
  private timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  private updated = false;

  constructor(
    private readonly app: App,
    private readonly plugin: Plugin,
    private readonly cfg: HttpConfig,
  ) {}

  start(): void {
    this.timers.push(setTimeout(() => void this.check(), INITIAL_DELAY_MS));
    this.timers.push(setInterval(() => void this.check(), CHECK_INTERVAL_MS));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>);
    this.timers = [];
  }

  private async check(): Promise<void> {
    if (this.updated) return; // don't re-download in the same session
    try {
      const [{ hash: serverHash }, localHash] = await Promise.all([
        fetchPluginVersion(this.cfg),
        this.localHash(),
      ]);
      if (!serverHash || serverHash === localHash) return;

      console.log(`[compendium] plugin update: ${localHash.slice(0, 7)} → ${serverHash.slice(0, 7)}`);
      const bytes = await fetchPluginBundle(this.cfg);
      await this.writeBundle(bytes);
      this.updated = true;

      new Notice(
        'Compendium updated in place. Press Ctrl/Cmd+R (or restart Obsidian) to apply.',
        0,
      );
    } catch (err) {
      console.error('[compendium] update check failed', err);
    }
  }

  private pluginDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
  }

  private async localHash(): Promise<string> {
    const buf = await this.app.vault.adapter.readBinary(`${this.pluginDir()}/main.js`);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async writeBundle(bytes: ArrayBuffer): Promise<void> {
    await this.app.vault.adapter.writeBinary(`${this.pluginDir()}/main.js`, bytes);
  }
}
