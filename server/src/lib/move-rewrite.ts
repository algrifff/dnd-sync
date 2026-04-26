// Helpers for rewriting wikilink targets inside note bodies after a
// path rename. Folder + note moves call `rewriteWikilinksForRenames`
// with the map of {oldPath -> newPath}; we walk every note that points
// at any old path (per the `note_links` index) and update the wikilink
// node attrs in their content_json + content_md + the Y.Doc state.
//
// The yjs_state rewrite throws away CRDT history for that note. That's
// acceptable here: a path rename is a structural edit and live editors
// are kicked first via closeDocumentConnections so they reconnect with
// fresh state. No unsaved keystrokes are at risk.

import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getDb } from './db';
import { getPmSchema } from './pm-schema';
import { pmToMarkdown } from './pm-to-md';
import { extractPlaintext, type PmNode } from './md-to-pm';

export type Rename = { from: string; to: string };

/** Discover the set of linker notes that point at any of the
 *  to-be-renamed paths. Must be called BEFORE the move transaction
 *  rewrites note_links — once the transaction has flipped to_path to
 *  the new value, the IN-clause query here finds nothing. */
export function findWikilinkLinkers(
  groupId: string,
  fromPaths: string[],
): string[] {
  if (fromPaths.length === 0) return [];
  const placeholders = fromPaths.map(() => '?').join(',');
  const rows = getDb()
    .query<{ from_path: string }, string[]>(
      `SELECT DISTINCT from_path FROM note_links
        WHERE group_id = ? AND to_path IN (${placeholders})`,
    )
    .all(groupId, ...fromPaths);
  return rows.map((r) => r.from_path);
}

/** Rewrite every linker note that points at any of the renamed paths.
 *  Returns the set of linker paths that were touched, so the caller
 *  can closeDocumentConnections() on each. */
export function rewriteWikilinksForRenames(
  groupId: string,
  renames: Rename[],
): string[] {
  if (renames.length === 0) return [];
  const linkers = findWikilinkLinkers(
    groupId,
    renames.map((r) => r.from),
  );
  return rewriteWikilinksForLinkers(groupId, linkers, renames);
}

/** Walk a pre-computed linker set and rewrite their wikilink targets
 *  per the rename map. Used by the folder-move flow where the linker
 *  discovery has to happen before the transaction (to_path edges get
 *  rewritten in-place by the move) but the body rewrite must run
 *  after, so the new paths are reachable. */
export function rewriteWikilinksForLinkers(
  groupId: string,
  linkers: string[],
  renames: Rename[],
): string[] {
  if (linkers.length === 0 || renames.length === 0) return [];

  const map = new Map<string, string>();
  for (const r of renames) map.set(r.from, r.to);

  const db = getDb();
  const touched: string[] = [];
  const now = Date.now();
  for (const linker of linkers) {
    if (!linker) continue;
    const row = db
      .query<
        { content_json: string; yjs_state: Uint8Array | null; title: string },
        [string, string]
      >(
        'SELECT content_json, yjs_state, title FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, linker);
    if (!row) continue;

    let pm: PmNode;
    try {
      pm = JSON.parse(row.content_json) as PmNode;
    } catch {
      continue;
    }
    const changed = rewriteWikilinkTargets(pm, map);
    if (!changed) continue;

    const newJson = JSON.stringify(pm);
    const newText = extractPlaintext(pm);
    const newMd = pmToMarkdown(pm);

    // Round-trip the PM JSON through y-prosemirror to get a fresh
    // yjs_state. The Y.Text('title') sidecar is preserved verbatim
    // because hocuspocus reads it as a separate field — but we can
    // restore the title from the existing row to keep parity.
    const ydoc = prosemirrorJSONToYDoc(getPmSchema(), pm, 'default');
    if (row.title) ydoc.getText('title').insert(0, row.title);
    const state = Y.encodeStateAsUpdate(ydoc);

    db.query(
      `UPDATE notes
          SET content_json = ?,
              content_text = ?,
              content_md   = ?,
              yjs_state    = ?,
              byte_size    = ?,
              updated_at   = ?
        WHERE group_id = ? AND path = ?`,
    ).run(newJson, newText, newMd, state, newMd.length, now, groupId, linker);

    // Refresh the FTS mirror so search hits land on the new content.
    db.query('DELETE FROM notes_fts WHERE path = ? AND group_id = ?').run(
      linker,
      groupId,
    );
    db.query(
      'INSERT INTO notes_fts(path, group_id, title, content) VALUES (?, ?, ?, ?)',
    ).run(linker, groupId, row.title, newText);

    // note_links also need rewriting for this linker — the existing
    // route updates note_links for the MOVED rows' own from/to, but
    // a linker's edges (this note → renamed target) still hold the
    // old to_path. Rewrite directly here so the graph is consistent.
    for (const r of renames) {
      db.query(
        `UPDATE OR IGNORE note_links
            SET to_path = ?
          WHERE group_id = ? AND from_path = ? AND to_path = ?`,
      ).run(r.to, groupId, linker, r.from);
      // The OR IGNORE guards against the case where (linker, r.to)
      // already exists — drop the dupe that would have collided.
      db.query(
        'DELETE FROM note_links WHERE group_id = ? AND from_path = ? AND to_path = ?',
      ).run(groupId, linker, r.from);
    }

    touched.push(linker);
  }

  return touched;
}

/** Walk a ProseMirror tree and rewrite wikilink `target` attrs that
 *  match any rename. Mutates the tree in place. Returns true if any
 *  node was rewritten. */
function rewriteWikilinkTargets(
  node: PmNode,
  map: Map<string, string>,
): boolean {
  let changed = false;
  if (node.type === 'wikilink' || node.type === 'embedNote') {
    const target = String(node.attrs?.target ?? '');
    const remapped = map.get(target);
    if (remapped) {
      node.attrs = { ...node.attrs, target: remapped };
      changed = true;
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (rewriteWikilinkTargets(child, map)) changed = true;
    }
  }
  return changed;
}
