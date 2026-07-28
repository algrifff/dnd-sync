// Shared helper for every write path that rebuilds a note's yjs_state
// from a freshly-computed ProseMirror document (entity_edit_content,
// backlink_create, writeFullContent, move-rewrite, campaign-index,
// userCharacterSync).
//
// N1 (data loss): `prosemirrorJSONToYDoc(...)` builds a brand new
// Y.Doc containing ONLY the `default` XmlFragment + a fresh `title`
// Y.Text. A real note's Y.Doc also carries other roots — notably
// `drawing-strokes-v3` (DrawingOverlay.tsx's live freehand annotation
// layer) and `excalidraw-elements` / `excalidraw-appState` (canvas
// notes). Discarding the old doc and building a fresh one silently
// drops all of that the moment any of these write paths touches a note
// that has annotations on it.
//
// Fix: seed the rebuild doc from the EXISTING encoded state first (so
// every pre-existing Y root survives untouched), then replace only the
// `default` fragment's content and the `title` text via y-prosemirror's
// `updateYFragment` — the same reconciliation the live ySyncPlugin uses
// on every keystroke — instead of discarding the whole doc.
//
// Invariant: after rebuildYjsState, every Y root that existed in
// `existingState` still exists, except `default` and `title`, which
// reflect `nextDoc` / `title` exactly.
//
// Corrupt-state guard: `Y.applyUpdate` throws (e.g. "Unexpected end of
// array") on a truncated/corrupt `existingState` blob. That decode
// failure happens before any struct is integrated into `ydoc` for a
// pure truncation, which leaves `ydoc` pristine-empty — equivalent to
// the pre-N1 behaviour (fresh doc, foreign Y roots lost). But
// `Y.applyUpdate` is not all-or-nothing: fuzzing single-byte corruption
// found cases where some structs integrate before the throw, leaving
// `ydoc` partially populated rather than pristine. Either outcome is
// safe to encode — a partially-integrated doc is still self-consistent
// — so this is handled centrally here without each call site needing
// its own try/catch; only the "always pristine" claim would have been
// wrong, not the safety of continuing.
//
// `title` contract: `undefined` (the parameter omitted) leaves the
// existing `title` Y.Text untouched. An explicit `''` is NOT treated
// as "leave alone" — it wholesale-replaces the title with empty text,
// same as any other string. Callers that want "don't touch the title
// unless we actually have one" must pass `title || undefined`
// themselves (see campaign-index.ts, move-rewrite.ts,
// userCharacterSync.ts, and the three call sites in ai/tools.ts —
// entity_edit_content, entity_move, writeFullContent).

import * as Y from 'yjs';
import { updateYFragment } from 'y-prosemirror';
import type { Node as PmNode, MarkType, Schema } from 'prosemirror-model';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

// `createEmptyMeta` is an internal helper in y-prosemirror's
// sync-plugin module and isn't re-exported from the package root —
// build the same shape ourselves (see BindingMetadata in
// y-prosemirror/src/plugins/sync-plugin.js: { mapping, isOMark }).
type ProsemirrorMapping = Map<Y.AbstractType<unknown>, PmNode | PmNode[]>;
type BindingMetadata = { mapping: ProsemirrorMapping; isOMark: Map<MarkType, boolean> };

function emptyMeta(): BindingMetadata {
  return { mapping: new Map(), isOMark: new Map() };
}

/**
 * Rebuild the `yjs_state` blob for a note, preserving every Y root
 * other than `default` (body) and `title`.
 *
 * @param schema        The shared PM schema (getPmSchema()).
 * @param existingState The note's current yjs_state blob, or null/
 *                       undefined for a brand-new note — falls back to
 *                       building a fresh Y.Doc in that case (this is
 *                       the pre-existing, safe behaviour for creation
 *                       paths; there is nothing to preserve yet).
 * @param nextDoc        The full next ProseMirror document
 *                       (`{ type: 'doc', content: [...] }`) to write
 *                       into the `default` fragment.
 * @param title          When provided, replaces the `title` Y.Text
 *                       wholesale. When omitted, the existing title
 *                       text (if any) is left untouched.
 */
export function rebuildYjsState(
  schema: Schema,
  existingState: Uint8Array | null | undefined,
  nextDoc: object,
  title?: string,
): Uint8Array {
  const ydoc = new Y.Doc();
  if (existingState && existingState.length > 0) {
    try {
      Y.applyUpdate(ydoc, existingState);
    } catch (err) {
      console.error(
        '[yjs-rebuild] unreadable existing state, rebuilding fresh:',
        err,
      );
      void captureServer({
        event: EVENTS.API_ERROR,
        properties: { route: 'yjs-rebuild.applyUpdate', reason: String(err) },
      });
    }
  }

  const pmNode = schema.nodeFromJSON(nextDoc);
  const fragment = ydoc.getXmlFragment('default');

  ydoc.transact(() => {
    updateYFragment(ydoc, fragment, pmNode, emptyMeta());
    if (title !== undefined) {
      const titleText = ydoc.getText('title');
      if (titleText.length > 0) titleText.delete(0, titleText.length);
      if (title) titleText.insert(0, title);
    }
  });

  return Y.encodeStateAsUpdate(ydoc);
}
