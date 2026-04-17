// Status bar indicator. Colored dot + short text; click opens the
// plugin's settings tab.

import type { App } from 'obsidian';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected';

export class StatusBar {
  private el: HTMLElement;

  constructor(host: HTMLElement, private readonly app: App) {
    this.el = host;
    this.el.addClass('compendium-status');
    this.el.style.cursor = 'pointer';
    this.el.onclick = (): void => {
      // Open plugin settings tab. `setting.open` is public; the cast quiets
      // Obsidian's private setting API surface.
      (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.open();
      (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById(
        'compendium',
      );
    };
    this.render('idle', 0);
  }

  render(status: Status, docCount: number): void {
    const { dot, label } = this.format(status, docCount);
    this.el.setText(`${dot} Compendium: ${label}`);
  }

  private format(status: Status, docCount: number): { dot: string; label: string } {
    switch (status) {
      case 'connected':
        return { dot: '🟢', label: `connected (${docCount})` };
      case 'connecting':
        return { dot: '🟡', label: 'connecting…' };
      case 'disconnected':
        return { dot: '🔴', label: 'disconnected' };
      case 'idle':
      default:
        return { dot: '⚪', label: 'idle' };
    }
  }

  dispose(): void {
    this.el.onclick = null;
    this.el.empty();
  }
}
