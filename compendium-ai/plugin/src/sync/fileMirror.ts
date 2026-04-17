// Bridges Obsidian vault events ↔ Yjs docs for markdown files.
//
// Feedback loops are avoided through two orthogonal checks:
//   * Our ytext writes use LOCAL_ORIGIN; the observer ignores transactions
//     carrying that origin so they don't trigger a file write downstream.
//   * Our file writes stash the last-written content per path. When the
//     vault fires 'modify' and the file's content matches what we just
//     wrote, we skip — it's our own echo. This replaces the earlier
//     `ignoreNextModify` Set, which was add-only and couldn't track
//     overlapping writes triggered by bursts of remote updates.
//
// Remote updates are debounced per path (150 ms) so rapid-fire character
// edits from a typing peer don't translate to a write-per-keystroke on disk.

import { MarkdownView, Notice, TFile } from 'obsidian';
import type { App, EventRef, TAbstractFile } from 'obsidian';
import type * as Y from 'yjs';
import { MARKDOWN_EXTENSIONS } from '@compendium/shared';
import type { DocRegistry } from './docRegistry';
import { fetchInventory, type HttpConfig } from './http';

const LOCAL_ORIGIN = Symbol('compendium.local');
const WRITE_DEBOUNCE_MS = 150;

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

type Tracked = {
  observer: (e: Y.YTextEvent, tx: Y.Transaction) => void;
  ytext: Y.Text;
};

export class FileMirror {
  /** Last content we successfully wrote to each path. The vault.modify
   *  handler consults this — if the file content matches, it's our own
   *  echo and we skip. Multiple overlapping writes are handled because
   *  this tracks actual bytes rather than a "has been written" flag. */
  private readonly lastWritten = new Map<string, string>();
  private readonly writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly eventRefs: EventRef[] = [];
  private started = false;

  constructor(
    private readonly app: App,
    private readonly registry: DocRegistry,
    private readonly cfg: HttpConfig,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Track every markdown file already in the vault.
    for (const file of this.app.vault.getMarkdownFiles()) {
      void this.track(file.path);
    }

    // Pull down server-side docs we don't have locally.
    await this.syncInventory();

    this.eventRefs.push(
      this.app.vault.on('modify', (f) => {
        if (f instanceof TFile && isMarkdown(f.path)) void this.onLocalModify(f);
      }),
      this.app.vault.on('create', (f) => {
        if (f instanceof TFile && isMarkdown(f.path)) void this.onLocalCreate(f);
      }),
      this.app.vault.on('delete', (f: TAbstractFile) => {
        if (f instanceof TFile && isMarkdown(f.path)) this.onLocalDelete(f.path);
      }),
      this.app.vault.on('rename', (f, oldPath) => {
        if (f instanceof TFile && isMarkdown(f.path)) void this.onLocalRename(f, oldPath);
      }),
    );
  }

  private async syncInventory(): Promise<void> {
    try {
      const inventory = await fetchInventory(this.cfg);
      for (const entry of inventory.textDocs) {
        if (!this.tracked.has(entry.path)) void this.track(entry.path);
      }
    } catch (err) {
      console.error('[compendium] inventory fetch failed', err);
    }
  }

  stop(): void {
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs.length = 0;
    for (const timer of this.writeTimers.values()) clearTimeout(timer);
    this.writeTimers.clear();
    // Provider/doc lifecycle is owned by DocRegistry.destroyAll().
    for (const t of this.tracked.values()) t.ytext.unobserve(t.observer);
    this.tracked.clear();
    this.lastWritten.clear();
    this.started = false;
  }

  // ── Tracking ────────────────────────────────────────────────────────────

  private async track(path: string): Promise<void> {
    if (this.tracked.has(path)) return;
    const { doc, provider } = this.registry.get(path);
    const ytext = doc.getText('content');

    const observer: Tracked['observer'] = (_event, tx) => {
      if (tx.origin === LOCAL_ORIGIN) return;
      // If the file is open in an editor, yCollab (in CmBinding) applies
      // character-level updates directly to the EditorView and Obsidian
      // auto-saves on change. Writing the whole file here would race with
      // y-codemirror's position mapping.
      if (this.isFileOpen(path)) return;
      this.scheduleWrite(path);
    };
    ytext.observe(observer);
    this.tracked.set(path, { ytext, observer });

    // After the initial server sync, reconcile the local file.
    void this.reconcileAfterSync(path, provider, ytext);
  }

  private reconcileAfterSync(path: string, provider: { once(ev: 'sync', cb: (synced: boolean) => void): void; synced: boolean }, ytext: Y.Text): Promise<void> {
    const run = async (): Promise<void> => {
      const file = this.app.vault.getAbstractFileByPath(path);
      const localText = file instanceof TFile ? await this.app.vault.read(file) : '';
      const serverText = ytext.toString();

      if (serverText === '' && localText !== '') {
        // Server hasn't seen this file — push local content up.
        const doc = this.registry.get(path).doc;
        doc.transact(() => {
          ytext.insert(0, localText);
        }, LOCAL_ORIGIN);
      } else if (serverText !== localText) {
        // Server is canonical — overwrite local.
        await this.writeLocal(path, serverText);
      }
    };

    if (provider.synced) return run();
    return new Promise<void>((resolve) => {
      provider.once('sync', (synced) => {
        if (synced) void run().finally(resolve);
        else resolve();
      });
    });
  }

  // ── Vault event handlers ────────────────────────────────────────────────

  private async onLocalModify(file: TFile): Promise<void> {
    // If the file is open in an editor, yCollab streams keystroke-level
    // changes into ytext — a coarse delete+insert here would race with it.
    if (this.isFileOpen(file.path)) return;

    if (!this.tracked.has(file.path)) {
      await this.track(file.path);
    }
    const t = this.tracked.get(file.path);
    if (!t) return;

    const content = await this.app.vault.read(file);

    // Echo check: if the file's content matches what we most recently wrote
    // from a remote update, this modify event is our own write coming back.
    // Safe to ignore — survives overlapping writes because we compare actual
    // bytes rather than consuming a one-shot flag.
    if (this.lastWritten.get(file.path) === content) return;

    // Local content truly differs from ytext → push the change up.
    if (t.ytext.toString() === content) return;
    const doc = this.registry.get(file.path).doc;
    doc.transact(() => {
      t.ytext.delete(0, t.ytext.length);
      t.ytext.insert(0, content);
    }, LOCAL_ORIGIN);
  }

  private isFileOpen(path: string): boolean {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) return true;
    }
    return false;
  }

  private async onLocalCreate(file: TFile): Promise<void> {
    await this.track(file.path);
    // The reconcile step inside track() handles the initial push.
  }

  private onLocalDelete(path: string): void {
    const t = this.tracked.get(path);
    if (t) {
      t.ytext.unobserve(t.observer);
      this.tracked.delete(path);
    }
    this.registry.delete(path);
    // Server-side text_docs rows linger after local deletion — the server
    // doesn't yet expose a DELETE endpoint for text docs. Low-priority
    // correctness gap: orphans add DB size but don't misbehave.
  }

  private async onLocalRename(file: TFile, oldPath: string): Promise<void> {
    // Simplest correct behaviour: treat like delete(old) + create(new).
    this.onLocalDelete(oldPath);
    await this.onLocalCreate(file);
  }

  // ── File I/O ────────────────────────────────────────────────────────────

  /** Queue a debounced write; coalesces rapid remote updates into one
   *  disk write per debounce window. Always reads the latest ytext at
   *  flush time so we write the most recent content even if the timer
   *  fires later than expected. */
  private scheduleWrite(path: string): void {
    const existing = this.writeTimers.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.writeTimers.delete(path);
      const record = this.tracked.get(path);
      if (!record) return;
      void this.writeLocal(path, record.ytext.toString());
    }, WRITE_DEBOUNCE_MS);
    this.writeTimers.set(path, timer);
  }

  private async writeLocal(path: string, content: string): Promise<void> {
    // Record what we're about to write BEFORE dispatching vault.modify so
    // the event handler (which fires as part of vault.modify / vault.create
    // bookkeeping) can recognise its own echo synchronously.
    this.lastWritten.set(path, content);
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else if (!existing) {
        await this.ensureFolderFor(path);
        await this.app.vault.create(path, content);
      }
    } catch (err) {
      this.lastWritten.delete(path);
      new Notice(`Compendium: failed to write ${path}`);
      console.error('[compendium] writeLocal failed', path, err);
    }
  }

  private async ensureFolderFor(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return;
    const dir = path.slice(0, lastSlash);
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir);
    }
  }
}
