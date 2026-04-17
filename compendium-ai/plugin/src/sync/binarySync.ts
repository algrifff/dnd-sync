// Binary file sync: images, PDFs, Excalidraw drawings.
//
// Binaries are too costly to CRDT (and the content is rarely edited by more
// than one person at a time), so we treat each file as a blob: on local
// write we PUT it, on local delete we DELETE, on startup we pull anything
// on the server that isn't present locally. Conflicts resolve last-write-wins.

import { Notice, TFile } from 'obsidian';
import type { App, EventRef, TAbstractFile } from 'obsidian';
import { BINARY_EXTENSIONS } from '@compendium/shared';
import { deleteBinary, fetchInventory, getBinary, putBinary } from './http';
import type { HttpConfig } from './http';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function isBinary(path: string): boolean {
  const lower = path.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function mimeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export class BinarySync {
  private readonly eventRefs: EventRef[] = [];
  private started = false;

  constructor(
    private readonly app: App,
    private readonly cfg: HttpConfig,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.eventRefs.push(
      this.app.vault.on('create', (f) => {
        if (f instanceof TFile && isBinary(f.path)) void this.uploadSafely(f);
      }),
      this.app.vault.on('modify', (f) => {
        if (f instanceof TFile && isBinary(f.path)) void this.uploadSafely(f);
      }),
      this.app.vault.on('delete', (f: TAbstractFile) => {
        if (f instanceof TFile && isBinary(f.path)) void this.deleteSafely(f.path);
      }),
      this.app.vault.on('rename', (f, oldPath) => {
        if (f instanceof TFile && isBinary(f.path)) {
          void this.deleteSafely(oldPath);
          void this.uploadSafely(f);
        }
      }),
    );

    await this.pullMissing();
  }

  stop(): void {
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs.length = 0;
    this.started = false;
  }

  // ── Pulls ───────────────────────────────────────────────────────────────

  private async pullMissing(): Promise<void> {
    let inventory;
    try {
      inventory = await fetchInventory(this.cfg);
    } catch (err) {
      console.error('[compendium] inventory fetch failed', err);
      return;
    }

    for (const entry of inventory.binaryFiles) {
      const existing = this.app.vault.getAbstractFileByPath(entry.path);
      if (existing) continue;
      try {
        const data = await getBinary(this.cfg, entry.path);
        if (!data) continue;
        await this.ensureFolderFor(entry.path);
        await this.app.vault.createBinary(entry.path, data);
      } catch (err) {
        console.error('[compendium] failed to pull binary', entry.path, err);
      }
    }
  }

  private async ensureFolderFor(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return;
    const dir = path.slice(0, lastSlash);
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    await this.app.vault.createFolder(dir);
  }

  // ── Pushes ──────────────────────────────────────────────────────────────

  private async uploadSafely(file: TFile): Promise<void> {
    try {
      const data = await this.app.vault.readBinary(file);
      await putBinary(this.cfg, file.path, data, mimeFor(file.path));
    } catch (err) {
      console.error('[compendium] upload failed', file.path, err);
      new Notice(`Compendium: failed to upload ${file.path}`);
    }
  }

  private async deleteSafely(path: string): Promise<void> {
    try {
      await deleteBinary(this.cfg, path);
    } catch (err) {
      console.error('[compendium] delete failed', path, err);
    }
  }
}
