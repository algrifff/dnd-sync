// Bridges Obsidian vault events ↔ Yjs docs for markdown files.
//
// Two flows to reconcile:
//   Local edit  → vault.on('modify') → replace ytext → Yjs broadcasts
//   Remote edit → Yjs observer → write file → (vault.on('modify') fires but we ignore it)
//
// Feedback loops are prevented in two ways:
//   * Our file writes set a per-path "ignore-next-modify" flag. The vault
//     handler clears it and returns without reprocessing.
//   * Our ytext transactions use LOCAL_ORIGIN. The observer ignores updates
//     that carry this origin so they don't immediately re-write the file.

import { MarkdownView, Notice, TFile } from 'obsidian';
import type { App, EventRef, TAbstractFile } from 'obsidian';
import type * as Y from 'yjs';
import { MARKDOWN_EXTENSIONS } from '@compendium/shared';
import type { DocRegistry } from './docRegistry';
import { fetchInventory, type HttpConfig } from './http';

const LOCAL_ORIGIN = Symbol('compendium.local');

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

type Tracked = {
  observer: (e: Y.YTextEvent, tx: Y.Transaction) => void;
  ytext: Y.Text;
};

export class FileMirror {
  private readonly ignoreNextModify = new Set<string>();
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
    for (const [path, t] of this.tracked) {
      t.ytext.unobserve(t.observer);
      // Provider/doc lifecycle is owned by DocRegistry.destroyAll().
      void path;
    }
    this.tracked.clear();
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
      // y-codemirror's position mapping and has caused 'null parent' crashes.
      if (this.isFileOpen(path)) return;
      void this.writeLocal(path, ytext.toString());
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
    if (this.ignoreNextModify.has(file.path)) {
      this.ignoreNextModify.delete(file.path);
      return;
    }

    // If the file is open in an editor, yCollab streams keystroke-level
    // changes into ytext — a coarse delete+insert here would race with it
    // and clobber in-flight character edits.
    if (this.isFileOpen(file.path)) return;

    if (!this.tracked.has(file.path)) {
      await this.track(file.path);
    }

    const t = this.tracked.get(file.path);
    if (!t) return;
    const content = await this.app.vault.read(file);
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
    // Server-side text_docs deletion wires in when the DELETE endpoint
    // lands; for now the row lingers until 4.4.
  }

  private async onLocalRename(file: TFile, oldPath: string): Promise<void> {
    // Simplest correct behaviour: treat like delete(old) + create(new).
    this.onLocalDelete(oldPath);
    await this.onLocalCreate(file);
  }

  // ── File I/O ────────────────────────────────────────────────────────────

  private async writeLocal(path: string, content: string): Promise<void> {
    this.ignoreNextModify.add(path);
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else if (!existing) {
        // Make sure any parent folders exist.
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash > 0) {
          const dir = path.slice(0, lastSlash);
          if (!this.app.vault.getAbstractFileByPath(dir)) {
            await this.app.vault.createFolder(dir);
          }
        }
        await this.app.vault.create(path, content);
      }
    } catch (err) {
      this.ignoreNextModify.delete(path);
      new Notice(`Compendium: failed to write ${path}`);
      console.error('[compendium] writeLocal failed', path, err);
    }
  }
}
