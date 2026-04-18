// Binary file sync: images, PDFs, Excalidraw drawings.
//
// Binaries are too costly to CRDT (and the content is rarely edited by more
// than one person at a time), so we treat each file as a blob: on local
// write we PUT it, on local delete we DELETE, on startup we pull anything
// on the server that isn't present locally. Conflicts resolve last-write-wins.

import { Notice, TFile } from 'obsidian';
import type { App, EventRef, TAbstractFile } from 'obsidian';
import { BINARY_EXTENSIONS } from '@compendium/shared';
import type { DocRegistry } from './docRegistry';
import { deleteBinary, fetchInventory, getBinary, putBinary } from './http';
import type { HttpConfig } from './http';
import { retryWithBackoff, shortError } from './retry';

const MIME: Record<string, string> = {
  // images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tiff': 'image/tiff',
  '.ico': 'image/vnd.microsoft.icon',
  '.avif': 'image/avif',
  // video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  // audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  // docs
  '.pdf': 'application/pdf',
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
    private readonly registry: DocRegistry,
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

    await this.reconcile();
  }

  stop(): void {
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs.length = 0;
    this.started = false;
  }

  // ── Two-way bootstrap ──────────────────────────────────────────────────
  //
  // On startup we need to reconcile both directions so that binary files
  // that existed before the plugin was enabled end up on the server, and
  // binaries uploaded from other clients land on disk here. Both vault
  // events (create/modify/delete) only fire for changes that happen after
  // the plugin is running, so this is the bootstrapping step.

  private async reconcile(): Promise<void> {
    let inventory;
    try {
      inventory = await retryWithBackoff(() => fetchInventory(this.cfg), {
        onAttempt: (n, err) => {
          this.registry.setGlobalError(`binary inventory retry ${n}/5: ${shortError(err)}`);
        },
      });
    } catch (err) {
      this.registry.setGlobalError(`binary inventory failed: ${shortError(err)}`);
      console.error('[compendium] binary inventory fetch failed after retries', err);
      return;
    }
    this.registry.clearGlobalError();

    const serverPaths = new Set(inventory.binaryFiles.map((f) => f.path));

    // Server → local: pull anything the server knows about that's missing here.
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

    // Local → server: push anything we have that the server doesn't.
    const localBinaries = this.app.vault.getFiles().filter((f) => isBinary(f.path));
    for (const file of localBinaries) {
      if (serverPaths.has(file.path)) continue;
      try {
        const data = await this.app.vault.readBinary(file);
        await putBinary(this.cfg, file.path, data, mimeFor(file.path));
      } catch (err) {
        console.error('[compendium] initial upload failed', file.path, err);
      }
    }
  }

  private async ensureFolderFor(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return;
    const dir = path.slice(0, lastSlash);
    // Dotfolders like `.obsidian/` live on disk but are not tracked in
    // Obsidian's abstract-file tree, so getAbstractFileByPath returns null
    // while createFolder throws "Folder already exists". Check the raw
    // adapter first; swallow the race on the createFolder path as a
    // defence-in-depth.
    if (await this.app.vault.adapter.exists(dir)) return;
    try {
      await this.app.vault.createFolder(dir);
    } catch (err) {
      if (err instanceof Error && /already exists/i.test(err.message)) return;
      throw err;
    }
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
