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
  compartment: Compartment;
  path: string;
  awareness: Awareness;
  undoManager: Y.UndoManager;
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
    for (const [leaf, bound] of this.bindings) {
      this.dispose(bound);
      void leaf; // suppress unused warning
    }
    this.bindings.clear();
  }

  updateIdentity(next: UserIdentity): void {
    this.identity = next;
    // Refresh each awareness so name/color changes take effect immediately.
    for (const { awareness } of this.bindings.values()) {
      awareness.setLocalStateField('user', {
        name: next.name,
        color: next.color,
        colorLight: next.colorLight,
      });
    }
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
    const file = view.file;
    const cm = extractCm(view);
    if (!cm) return;

    const existing = this.bindings.get(leaf);
    if (!file) {
      if (existing) {
        this.reconfigure(existing.cm, existing.compartment, []);
        existing.undoManager.destroy();
        this.bindings.delete(leaf);
      }
      return;
    }

    if (existing && existing.path === file.path && existing.cm === cm) return;

    if (existing) {
      this.reconfigure(existing.cm, existing.compartment, []);
      existing.undoManager.destroy();
      this.bindings.delete(leaf);
    }

    this.attach(leaf, cm, file.path);
  }

  private attach(leaf: WorkspaceLeaf, cm: EditorView, path: string): void {
    const record = this.registry.get(path);
    const ytext = record.doc.getText('content');
    const awareness = record.provider.awareness;
    awareness.setLocalStateField('user', {
      name: this.identity.name,
      color: this.identity.color,
      colorLight: this.identity.colorLight,
    });

    const undoManager = new Y.UndoManager(ytext);
    const ext = yCollab(ytext, awareness, { undoManager });

    const compartment = new Compartment();
    cm.dispatch({
      effects: StateEffect.appendConfig.of(compartment.of(ext)),
    });

    this.bindings.set(leaf, { leaf, cm, compartment, path, awareness, undoManager });
  }

  private reconfigure(cm: EditorView, compartment: Compartment, ext: unknown): void {
    cm.dispatch({
      effects: compartment.reconfigure(ext as Parameters<typeof compartment.reconfigure>[0]),
    });
  }

  private dispose(bound: Bound): void {
    this.reconfigure(bound.cm, bound.compartment, []);
    bound.undoManager.destroy();
  }
}

// Obsidian's Editor wrapper doesn't officially expose the CodeMirror 6 view,
// but it's stable as `editor.cm` on every version since the CM6 switch.
function extractCm(view: MarkdownView): EditorView | null {
  const editor = view.editor as unknown as { cm?: EditorView };
  return editor.cm ?? null;
}
