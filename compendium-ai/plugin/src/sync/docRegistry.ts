// One Y.Doc per vault path. Providers are created lazily and kept alive
// until the plugin unloads. An aggregate status bubbles up to the status
// bar: if any provider is disconnected/connecting, the aggregate reflects
// the most degraded state.

import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import { buildProvider, type ConnectionStatus, type SyncConfig } from './provider';

type DocRecord = {
  path: string;
  doc: Y.Doc;
  provider: WebsocketProvider;
  status: ConnectionStatus;
};

type AggregateStatus = ConnectionStatus | 'idle';
type Listener = (status: AggregateStatus, totalDocs: number) => void;

export class DocRegistry {
  private readonly records = new Map<string, DocRecord>();
  private readonly listeners = new Set<Listener>();
  private emitting = true;

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
    const record: DocRecord = { path, doc, provider, status: 'connecting' };
    this.records.set(path, record);

    provider.on('status', ({ status }: { status: ConnectionStatus }) => {
      record.status = status;
      this.emit();
    });

    this.emit();
    return record;
  }

  delete(path: string): void {
    const record = this.records.get(path);
    if (!record) return;
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
      record.provider.destroy();
      record.doc.destroy();
    }
    this.records.clear();
    this.emitting = true;
    this.emit();
  }

  size(): number {
    return this.records.size;
  }

  /** Subscribe to aggregate status changes. Returns an unsubscribe function. */
  onStatusChange(listener: Listener): () => void {
    this.listeners.add(listener);
    // Push current state immediately so UI initialises correctly.
    listener(this.aggregate(), this.records.size);
    return () => this.listeners.delete(listener);
  }

  private aggregate(): AggregateStatus {
    if (this.records.size === 0) return 'idle';
    let anyDisconnected = false;
    let anyConnecting = false;
    for (const record of this.records.values()) {
      if (record.status === 'disconnected') anyDisconnected = true;
      else if (record.status === 'connecting') anyConnecting = true;
    }
    if (anyDisconnected) return 'disconnected';
    if (anyConnecting) return 'connecting';
    return 'connected';
  }

  private emit(): void {
    if (!this.emitting) return;
    const status = this.aggregate();
    const size = this.records.size;
    for (const listener of this.listeners) listener(status, size);
  }
}
