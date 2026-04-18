// One Y.Doc per vault path. Providers are created lazily and kept alive
// until the plugin unloads. An aggregate status bubbles up to the status
// bar: if any provider is disconnected/connecting (or hasn't completed
// initial sync yet), the aggregate reflects the most degraded state.
//
// "Connected" here is stricter than y-websocket's own 'connected' event: a
// doc must have both WS status === 'connected' AND provider.synced === true
// before it counts as green. This stops the status bar reporting 🟢 when
// the WS handshake succeeded but no Yjs state has actually been exchanged.

import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import { buildProvider, type ConnectionStatus, type SyncConfig } from './provider';

const CONNECT_TIMEOUT_MS = 30_000;

type DocRecord = {
  path: string;
  doc: Y.Doc;
  provider: WebsocketProvider;
  status: ConnectionStatus;
  /** Flipped true once the provider's 'sync' event fires with state=true.
   *  Reset on every disconnect so reconnect flow waits for fresh sync. */
  synced: boolean;
  /** Most recent user-facing failure reason for this doc, or null if healthy.
   *  Surfaces in the status-bar tooltip. Never contains the auth token. */
  lastError: string | null;
  /** Timer that escalates a stuck 'connecting' to 'disconnected'. Cleared
   *  the moment the provider reports 'connected'. */
  connectTimer: ReturnType<typeof setTimeout> | null;
};

type AggregateStatus = ConnectionStatus | 'idle';
type Listener = (status: AggregateStatus, totalDocs: number, errors: string[]) => void;

export class DocRegistry {
  private readonly records = new Map<string, DocRecord>();
  private readonly listeners = new Set<Listener>();
  private emitting = true;
  /** Non-doc-scoped error (e.g. "inventory retry 3/5"). Surfaced in the
   *  same tooltip path as per-doc errors so the user sees one list. */
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
      }
      this.emit();
    });

    provider.on('sync', (synced: boolean) => {
      record.synced = synced;
      if (synced) record.lastError = null;
      this.emit();
    });

    provider.on('connection-error', (event: Event) => {
      record.lastError = describeError(event);
      this.emit();
    });

    provider.on('connection-close', (event: CloseEvent | null) => {
      record.synced = false;
      // 1008 = policy violation (our upgrade handler's missing-doc path).
      // 4401 is a soft convention we may use for auth-specific closes.
      if (event && (event.code === 1008 || event.code === 4401)) {
        record.lastError = 'auth rejected';
      } else if (event && event.code !== 1000 && event.code !== 1001) {
        record.lastError = `ws closed (${event.code})`;
      }
      this.emit();
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
    // Suppress per-provider status churn so the status bar doesn't flicker
    // through disconnected/connecting for every doc during teardown.
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

  /** Surface a registry-wide error (e.g. inventory retry) in the tooltip. */
  setGlobalError(reason: string): void {
    this.globalError = reason;
    this.emit();
  }

  clearGlobalError(): void {
    if (this.globalError === null) return;
    this.globalError = null;
    this.emit();
  }

  /** Subscribe to aggregate status changes. Returns an unsubscribe function. */
  onStatusChange(listener: Listener): () => void {
    this.listeners.add(listener);
    // Push current state immediately so UI initialises correctly.
    listener(this.aggregate(), this.records.size, this.errors());
    return () => this.listeners.delete(listener);
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

  private aggregate(): AggregateStatus {
    if (this.records.size === 0) return this.globalError ? 'disconnected' : 'idle';
    let anyDisconnected = false;
    let anyPending = false;
    for (const record of this.records.values()) {
      if (record.status === 'disconnected') anyDisconnected = true;
      else if (record.status === 'connecting' || !record.synced) anyPending = true;
    }
    if (anyDisconnected) return 'disconnected';
    if (anyPending) return 'connecting';
    return 'connected';
  }

  private emit(): void {
    if (!this.emitting) return;
    const status = this.aggregate();
    const size = this.records.size;
    const errs = this.errors();
    for (const listener of this.listeners) listener(status, size, errs);
  }
}

/** Best-effort extraction of a short, tokenless reason from a WS error event. */
function describeError(event: Event): string {
  // Browser/Electron WebSocket Event objects don't expose error text for
  // security reasons. The message property is only populated on ErrorEvent
  // (rare on WebSocket). Fall back to the event type.
  const maybeMsg = (event as { message?: unknown }).message;
  if (typeof maybeMsg === 'string' && maybeMsg.length > 0) return maybeMsg;
  return event.type || 'connection error';
}
