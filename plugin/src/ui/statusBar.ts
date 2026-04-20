// Status bar indicator. Shows the current sync phase with explicit counts
// so users can tell what the plugin is actually doing — connecting,
// downloading initial state, live and ready, or stuck.
//
// Hover reveals the most recent errors. Click opens the plugin settings.

import type { App } from 'obsidian';
import type { AggregateCounts, AggregateStatus } from '../sync/docRegistry';

export class StatusBar {
  private el: HTMLElement;

  constructor(host: HTMLElement, private readonly app: App) {
    this.el = host;
    this.el.addClass('compendium-status');
    this.el.style.cursor = 'pointer';
    this.el.onclick = (): void => {
      (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.open();
      (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById(
        'compendium',
      );
    };
    this.render('idle', emptyCounts(), []);
  }

  render(status: AggregateStatus, counts: AggregateCounts, errors: string[]): void {
    const { dot, label } = this.format(status, counts);
    this.el.setText(`${dot} ${label}`);

    const tooltip: string[] = [];
    tooltip.push(this.phaseDescription(status, counts));
    if (counts.total > 0) {
      tooltip.push(
        `Docs: ${counts.live} live · ${counts.syncing} syncing · ${counts.handshaking} connecting · ${counts.disconnected} disconnected`,
      );
      tooltip.push(`Traffic: ${counts.totalSent} sent · ${counts.totalReceived} received`);
    }
    if (errors.length > 0) {
      tooltip.push('');
      tooltip.push('Errors:');
      for (const e of errors.slice(0, 10)) tooltip.push('  · ' + e);
      if (errors.length > 10) tooltip.push(`  · (+${errors.length - 10} more)`);
    }
    this.el.title = tooltip.join('\n');
  }

  private format(status: AggregateStatus, c: AggregateCounts): { dot: string; label: string } {
    switch (status) {
      case 'live':
        return { dot: '🟢', label: `Live (${c.live})` };
      case 'syncing':
        return { dot: '🟠', label: `Syncing ${c.live}/${c.total}…` };
      case 'handshaking':
        return { dot: '🟡', label: `Connecting ${c.handshaking}/${c.total}…` };
      case 'disconnected':
        return { dot: '🔴', label: c.total === 0 ? 'Disconnected' : `Disconnected (${c.disconnected}/${c.total})` };
      case 'idle':
      default:
        return { dot: '⚪', label: 'Idle' };
    }
  }

  private phaseDescription(status: AggregateStatus, c: AggregateCounts): string {
    switch (status) {
      case 'live':
        return 'All docs synced. Edits propagate in real time.';
      case 'syncing':
        return `Downloading initial state for ${c.syncing} doc${c.syncing === 1 ? '' : 's'}.`;
      case 'handshaking':
        return `Opening WebSocket handshake for ${c.handshaking} doc${c.handshaking === 1 ? '' : 's'}.`;
      case 'disconnected':
        return 'Connection lost. Check hover for reason; y-websocket will auto-reconnect.';
      case 'idle':
      default:
        return 'Compendium is not actively tracking any doc.';
    }
  }

  dispose(): void {
    this.el.onclick = null;
    this.el.empty();
  }
}

function emptyCounts(): AggregateCounts {
  return {
    total: 0,
    handshaking: 0,
    syncing: 0,
    live: 0,
    disconnected: 0,
    totalReceived: 0,
    totalSent: 0,
  };
}
