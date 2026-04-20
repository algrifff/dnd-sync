// Binds Obsidian's CodeMirror editor to the per-file Y.Text via y-codemirror.
// Result: typing streams character-by-character, and remote clients'
// selections render as coloured cursors with name tags.
//
// One compartment per WorkspaceLeaf (pane). When the user switches files in
// the same pane, we reconfigure the compartment to point at the new doc's
// ytext; when the pane closes, we dispose the compartment's contents.

import { MarkdownView } from 'obsidian';
import type { App, EventRef, WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { Compartment, StateEffect } from '@codemirror/state';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import type { DocRegistry } from '../sync/docRegistry';

export type UserIdentity = {
  name: string;
  color: string;
  colorLight: string;
};

type Bound = {
  leaf: WorkspaceLeaf;
  cm: EditorView;
  /** One compartment per leaf, reused across file switches. Re-appending a
   *  fresh compartment on every switch would leak dormant ones into the
   *  editor's extension tree. */
  compartment: Compartment;
  /** Null while the compartment is reconfigured to the empty extension
   *  (i.e. we're between bindings on this leaf). */
  path: string | null;
  awareness: Awareness | null;
  undoManager: Y.UndoManager | null;
};

export class CmBinding {
  private readonly bindings = new Map<WorkspaceLeaf, Bound>();
  private readonly eventRefs: EventRef[] = [];

  constructor(
    private readonly app: App,
    private readonly registry: DocRegistry,
    private identity: UserIdentity,
  ) {}

  start(): void {
    // Any of these events can change the binding target.
    this.eventRefs.push(
      this.app.workspace.on('file-open', () => this.syncAll()),
      this.app.workspace.on('active-leaf-change', () => this.syncAll()),
      this.app.workspace.on('layout-change', () => this.syncAll()),
    );
    this.syncAll();
  }

  stop(): void {
    for (const ref of this.eventRefs) this.app.workspace.offref(ref);
    this.eventRefs.length = 0;
    for (const bound of this.bindings.values()) this.dispose(bound);
    this.bindings.clear();
  }

  updateIdentity(next: UserIdentity): void {
    this.identity = next;
    // Refresh each awareness so name/color changes take effect immediately.
    for (const bound of this.bindings.values()) {
      if (bound.awareness) bound.awareness.setLocalStateField('user', this.userField());
    }
  }

  private userField(): { name: string; color: string; colorLight: string } {
    return {
      name: this.identity.name,
      color: this.identity.color,
      colorLight: this.identity.colorLight,
    };
  }

  // ── Core sync loop ──────────────────────────────────────────────────────

  private syncAll(): void {
    const activeLeaves = new Set(this.app.workspace.getLeavesOfType('markdown'));

    // Drop bindings whose leaves have closed.
    for (const [leaf, bound] of [...this.bindings]) {
      if (!activeLeaves.has(leaf)) {
        this.dispose(bound);
        this.bindings.delete(leaf);
      }
    }

    // (Re)bind each live markdown leaf to its current file.
    for (const leaf of activeLeaves) {
      this.syncLeaf(leaf);
    }
  }

  private syncLeaf(leaf: WorkspaceLeaf): void {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const cm = extractCm(view);
    if (!cm) return;
    const file = view.file;

    const existing = this.bindings.get(leaf);

    // Pane closed without a file (rare). Detach the active extension but
    // keep the compartment around — the leaf might come back.
    if (!file) {
      if (existing) this.detach(existing);
      return;
    }

    // Same leaf, same file, same editor view — already wired up.
    if (existing && existing.cm === cm && existing.path === file.path) return;

    // The editor view itself was replaced (e.g. mode switch). Drop the
    // whole binding so we install a fresh compartment on the new view.
    if (existing && existing.cm !== cm) {
      this.detach(existing);
      this.bindings.delete(leaf);
    }

    this.bindFile(leaf, cm, file.path);
  }

  /** Attach yCollab for `path` on this editor view. Creates a compartment
   *  the first time we see this leaf+cm pair; reuses it for subsequent
   *  file switches via reconfigure. */
  private bindFile(leaf: WorkspaceLeaf, cm: EditorView, path: string): void {
    const record = this.registry.get(path);
    const ytext = record.doc.getText('content');
    const awareness = record.provider.awareness;
    awareness.setLocalStateField('user', this.userField());

    const undoManager = new Y.UndoManager(ytext);
    const ext = yCollab(ytext, awareness, { undoManager });

    let bound = this.bindings.get(leaf);
    if (bound && bound.cm === cm) {
      // Reuse the existing compartment — switch its contents to the new file.
      bound.undoManager?.destroy();
      cm.dispatch({ effects: bound.compartment.reconfigure(ext) });
      bound.path = path;
      bound.awareness = awareness;
      bound.undoManager = undoManager;
      return;
    }

    const compartment = new Compartment();
    cm.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(ext)) });
    bound = { leaf, cm, compartment, path, awareness, undoManager };
    this.bindings.set(leaf, bound);
  }

  /** Reconfigure the compartment to no extension and drop UndoManager.
   *  The Bound entry stays so the next bindFile reuses the compartment. */
  private detach(bound: Bound): void {
    bound.cm.dispatch({ effects: bound.compartment.reconfigure([]) });
    bound.undoManager?.destroy();
    bound.path = null;
    bound.awareness = null;
    bound.undoManager = null;
  }

  /** Like detach but for full teardown — also forgets the binding. */
  private dispose(bound: Bound): void {
    this.detach(bound);
    this.bindings.delete(bound.leaf);
  }
}

// Obsidian's Editor wrapper doesn't officially expose the CodeMirror 6 view,
// but it's stable as `editor.cm` on every version since the CM6 switch.
function extractCm(view: MarkdownView): EditorView | null {
  const editor = view.editor as unknown as { cm?: EditorView };
  return editor.cm ?? null;
}
