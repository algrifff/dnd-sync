// One Y.Doc per vault path. Providers are created lazily and kept alive
// until the plugin unloads. An aggregate status bubbles up to the status
// bar with discrete lifecycle phases so the user can tell *what* the sync
// is doing (not just "green / not green").
//
// Per-doc lifecycle:
//   handshaking  — WebSocket TCP/TLS handshake in flight
//   syncing      — WS up, Yjs sync step 1/2 handshake in flight
//   live         — sync step 2 received; doc is ready for real-time ops
//   disconnected — WS closed or errored; y-websocket will auto-reconnect
//
// Aggregate (across all docs):
//   idle          — no config / no docs tracked
//   handshaking   — ANY doc still handshaking (and none disconnected)
//   syncing       — all WS up but at least one doc still doing Yjs sync
//   live          — every doc is live
//   disconnected  — any doc disconnected (most degraded state)

import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import { buildProvider, type ConnectionStatus, type SyncConfig } from './provider';

const CONNECT_TIMEOUT_MS = 30_000;

export type DocPhase = 'handshaking' | 'syncing' | 'live' | 'disconnected';
export type AggregateStatus = 'idle' | 'handshaking' | 'syncing' | 'live' | 'disconnected';

export type DocReport = {
  path: string;
  phase: DocPhase;
  /** Count of Yjs updates we've BROADCAST from this client to the server. */
  sent: number;
  /** Count of Yjs updates we've RECEIVED from the server (other peers). */
  received: number;
  /** Millis since Unix epoch, or null if never. */
  lastSentAt: number | null;
  lastReceivedAt: number | null;
  lastError: string | null;
};

type DocRecord = {
  path: string;
  doc: Y.Doc;
  provider: WebsocketProvider;
  status: ConnectionStatus;
  synced: boolean;
  lastError: string | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
  sent: number;
  received: number;
  lastSentAt: number | null;
  lastReceivedAt: number | null;
};

type Listener = (
  status: AggregateStatus,
  counts: AggregateCounts,
  errors: string[],
) => void;

export type AggregateCounts = {
  total: number;
  handshaking: number;
  syncing: number;
  live: number;
  disconnected: number;
  /** Total Yjs updates received since registry creation. Rolling counter;
   *  lets the status bar prove to the user that real-time traffic is
   *  actually flowing. */
  totalReceived: number;
  totalSent: number;
};

export class DocRegistry {
  private readonly records = new Map<string, DocRecord>();
  private readonly listeners = new Set<Listener>();
  private emitting = true;
  private globalError: string | null = null;

  constructor(private readonly config: SyncConfig) {}

  getConfig(): SyncConfig {
    return this.config;
  }

  has(path: string): boolean {
    return this.records.has(path);
  }

  get(path: string): DocRecord {
    const existing = this.records.get(path);
    if (existing) return existing;

    const doc = new Y.Doc();
    const provider = buildProvider(this.config, path, doc);
    const record: DocRecord = {
      path,
      doc,
      provider,
      status: 'connecting',
      synced: false,
      lastError: null,
      connectTimer: null,
      sent: 0,
      received: 0,
      lastSentAt: null,
      lastReceivedAt: null,
    };
    this.records.set(path, record);

    record.connectTimer = setTimeout(() => {
      record.connectTimer = null;
      if (record.status !== 'connected') {
        record.status = 'disconnected';
        record.lastError = record.lastError ?? 'handshake timeout';
        this.emit();
      }
    }, CONNECT_TIMEOUT_MS);

    provider.on('status', ({ status }: { status: ConnectionStatus }) => {
      record.status = status;
      if (status === 'connected') {
        if (record.connectTimer) {
          clearTimeout(record.connectTimer);
          record.connectTimer = null;
        }
        record.lastError = null;
      } else if (status === 'disconnected') {
        record.synced = false;
        console.info(`[compendium] disconnected: ${path}${record.lastError ? ` (${record.lastError})` : ''}`);
      }
      this.emit();
    });

    provider.on('sync', (synced: boolean) => {
      const wasSynced = record.synced;
      record.synced = synced;
      if (synced) {
        record.lastError = null;
        if (!wasSynced) {
          console.info(`[compendium] live: ${path}`);
        }
      }
      this.emit();
    });

    provider.on('connection-error', (event: Event) => {
      record.lastError = describeError(event);
      this.emit();
    });

    provider.on('connection-close', (event: CloseEvent | null) => {
      record.synced = false;
      if (event && (event.code === 1008 || event.code === 4401)) {
        record.lastError = 'auth rejected';
      } else if (event && event.code !== 1000 && event.code !== 1001) {
        record.lastError = `ws closed (${event.code})`;
      }
      this.emit();
    });

    // Count updates. Origin === WebsocketProvider means "came from the
    // server" (the provider sets itself as origin when applying remote
    // sync messages). Anything else originated locally (yCollab edit,
    // our own pushToYtext, etc).
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      const now = Date.now();
      if (origin === provider) {
        record.received++;
        record.lastReceivedAt = now;
      } else {
        record.sent++;
        record.lastSentAt = now;
      }
      // No emit here — updates are frequent; we don't want to spam
      // listeners. The counters are read on demand via report().
    });

    this.emit();
    return record;
  }

  delete(path: string): void {
    const record = this.records.get(path);
    if (!record) return;
    if (record.connectTimer) clearTimeout(record.connectTimer);
    record.provider.destroy();
    record.doc.destroy();
    this.records.delete(path);
    this.emit();
  }

  destroyAll(): void {
    this.emitting = false;
    for (const record of this.records.values()) {
      if (record.connectTimer) clearTimeout(record.connectTimer);
      record.provider.destroy();
      record.doc.destroy();
    }
    this.records.clear();
    this.globalError = null;
    this.emitting = true;
    this.emit();
  }

  size(): number {
    return this.records.size;
  }

  setGlobalError(reason: string): void {
    this.globalError = reason;
    this.emit();
  }

  clearGlobalError(): void {
    if (this.globalError === null) return;
    this.globalError = null;
    this.emit();
  }

  onStatusChange(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.aggregate(), this.counts(), this.errors());
    return () => this.listeners.delete(listener);
  }

  /** Current status + counts + errors in one call. Used by the periodic
   *  status-bar refresh so traffic counters stay current while nothing
   *  structural is changing. */
  snapshot(): { status: AggregateStatus; counts: AggregateCounts; errors: string[] } {
    return { status: this.aggregate(), counts: this.counts(), errors: this.errors() };
  }

  errors(): string[] {
    const out: string[] = [];
    if (this.globalError) out.push(this.globalError);
    const seen = new Set<string>();
    for (const record of this.records.values()) {
      if (!record.lastError || seen.has(record.lastError)) continue;
      seen.add(record.lastError);
      out.push(`${record.path}: ${record.lastError}`);
    }
    return out;
  }

  counts(): AggregateCounts {
    const c: AggregateCounts = {
      total: this.records.size,
      handshaking: 0,
      syncing: 0,
      live: 0,
      disconnected: 0,
      totalReceived: 0,
      totalSent: 0,
    };
    for (const r of this.records.values()) {
      switch (phaseOf(r)) {
        case 'handshaking':
          c.handshaking++;
          break;
        case 'syncing':
          c.syncing++;
          break;
        case 'live':
          c.live++;
          break;
        case 'disconnected':
          c.disconnected++;
          break;
      }
      c.totalReceived += r.received;
      c.totalSent += r.sent;
    }
    return c;
  }

  /** Snapshot of every tracked doc — used by the "copy sync report"
   *  command so the user can paste a diagnostic blob when things go wrong. */
  report(): DocReport[] {
    return [...this.records.values()].map((r) => ({
      path: r.path,
      phase: phaseOf(r),
      sent: r.sent,
      received: r.received,
      lastSentAt: r.lastSentAt,
      lastReceivedAt: r.lastReceivedAt,
      lastError: r.lastError,
    }));
  }

  private aggregate(): AggregateStatus {
    if (this.records.size === 0) return this.globalError ? 'disconnected' : 'idle';
    let anyDisconnected = false;
    let anyHandshaking = false;
    let anySyncing = false;
    for (const r of this.records.values()) {
      const phase = phaseOf(r);
      if (phase === 'disconnected') anyDisconnected = true;
      else if (phase === 'handshaking') anyHandshaking = true;
      else if (phase === 'syncing') anySyncing = true;
    }
    if (anyDisconnected) return 'disconnected';
    if (anyHandshaking) return 'handshaking';
    if (anySyncing) return 'syncing';
    return 'live';
  }

  private emit(): void {
    if (!this.emitting) return;
    const status = this.aggregate();
    const counts = this.counts();
    const errs = this.errors();
    for (const listener of this.listeners) listener(status, counts, errs);
  }
}

function phaseOf(r: DocRecord): DocPhase {
  if (r.status === 'disconnected') return 'disconnected';
  if (r.status === 'connecting') return 'handshaking';
  // status === 'connected' below
  if (!r.synced) return 'syncing';
  return 'live';
}

function describeError(event: Event): string {
  const maybeMsg = (event as { message?: unknown }).message;
  if (typeof maybeMsg === 'string' && maybeMsg.length > 0) return maybeMsg;
  return event.type || 'connection error';
}
