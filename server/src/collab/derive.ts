// Post-store derive step. Every time hocuspocus persists a new Y state
// for a note, we regenerate the server-side caches (content_json for
// renderers, content_md for FTS + export, content_text for FTS, links
// for the graph, tags for the index).
//
// Title source is Y.Text('title') on the same Y.Doc — live-collab
// rename from the TitleEditor. Fallbacks are first-H1 (legacy ingest)
// and filename. Tags are the union of inline #mentions and the note's
// frontmatter.tags so explicit edits via the tag editor survive body
// saves.

import type * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { getDb } from '@/lib/db';
import { pmToMarkdown } from '@/lib/pm-to-md';
import { extractPlaintext, type PmNode } from '@/lib/md-to-pm';
import { deriveAllIndexes } from '@/lib/derive-indexes';

export type DerivedNote = {
  title: string;
  pmJson: PmNode;
  contentText: string;
  contentMd: string;
  wikilinks: string[];
  inlineTags: string[];
};

/** Pure CPU: Y.Doc -> PM JSON -> markdown/plaintext/links/tags. No DB
 *  access. Must run BEFORE the caller opens a transaction — this is
 *  the expensive part and holding the SQLite write lock across it
 *  stalls every route handler (separate connection, see db.ts
 *  busy_timeout). */
export function computeDerived(opts: { path: string; doc: Y.Doc }): DerivedNote {
  const pmJson = yDocToProsemirrorJSON(opts.doc, 'default') as unknown as PmNode;
  const yTitle = opts.doc.getText('title').toString().trim();
  const title = yTitle || extractTitle(pmJson) || filenameTitle(opts.path);
  const { wikilinks, tags: inlineTags } = collectLinksAndTags(pmJson);
  return {
    title,
    pmJson,
    contentText: extractPlaintext(pmJson),
    contentMd: pmToMarkdown(pmJson),
    wikilinks,
    inlineTags,
  };
}

/** DB-only half. MUST be called from inside a transaction the caller
 *  owns — it deliberately opens none of its own so the yjs_state
 *  UPDATE and these derived rows (and the FTS triggers they fire)
 *  commit or roll back together. */
export function persistDerived(opts: {
  groupId: string;
  path: string;
  userId: string | null;
  derived: DerivedNote;
}): void {
  const db = getDb();
  const { derived } = opts;

  const fmRow = db
    .query<{ frontmatter_json: string }, [string, string]>(
      'SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(opts.groupId, opts.path);
  const dmOnly = isDmOnly(fmRow?.frontmatter_json ?? '{}');
  const frontmatterTags = readFrontmatterTags(fmRow?.frontmatter_json ?? '{}');
  const allTags = [...new Set([...derived.inlineTags, ...frontmatterTags])];

  db.query(
    `UPDATE notes
        SET title = ?,
            content_json = ?,
            content_text = ?,
            content_md = ?,
            byte_size = ?,
            updated_at = ?,
            updated_by = COALESCE(?, updated_by),
            dm_only = ?
      WHERE group_id = ? AND path = ?`,
  ).run(
    derived.title,
    JSON.stringify(derived.pmJson),
    derived.contentText,
    derived.contentMd,
    derived.contentMd.length,
    Date.now(),
    opts.userId,
    dmOnly ? 1 : 0,
    opts.groupId,
    opts.path,
  );

  // Only delete body-derived links (is_manual = 0, is_index = 0). Manual
  // links (is_manual=1) created via the sidebar survive re-derive. Index
  // links (is_index=1) are managed by deriveFolderIndex and must also
  // survive — they are NOT in the note body and would be permanently lost
  // if wiped here.
  db.query(
    'DELETE FROM note_links WHERE group_id = ? AND from_path = ? AND is_manual = 0 AND is_index = 0',
  ).run(opts.groupId, opts.path);
  db.query('DELETE FROM tags WHERE group_id = ? AND path = ?').run(
    opts.groupId,
    opts.path,
  );

  const insertLink = db.query(
    `INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)`,
  );
  for (const link of derived.wikilinks) {
    if (link === opts.path) continue; // no self-loops
    insertLink.run(opts.groupId, opts.path, link);
  }

  const insertTag = db.query(
    `INSERT OR IGNORE INTO tags (group_id, path, tag) VALUES (?, ?, ?)`,
  );
  for (const tag of allTags) insertTag.run(opts.groupId, opts.path, tag);
}

/** Structured-index projection of frontmatter_json. Deliberately NOT
 *  part of the store transaction: the store path never writes
 *  frontmatter_json, so these tables cannot be made stale by it, and
 *  deriveCharacterFromFrontmatter opens its own transaction. Failures
 *  are logged and swallowed — same contract as before. */
export function deriveIndexesFor(groupId: string, path: string): void {
  try {
    // The SELECT is inside the try on purpose: this runs AFTER the store
    // transaction has committed, so a throw here would reject the
    // Hocuspocus store hook for a write that already succeeded.
    const fmRow = getDb()
      .query<{ frontmatter_json: string }, [string, string]>(
        'SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, path);
    deriveAllIndexes({
      groupId,
      notePath: path,
      frontmatterJson: fmRow?.frontmatter_json ?? '{}',
    });
  } catch (err) {
    console.error(`[derive] structured derive failed for ${path}:`, err);
  }
}

function extractTitle(doc: PmNode): string | null {
  for (const child of doc.content ?? []) {
    if (child.type === 'heading' && (child.attrs?.level ?? 1) === 1) {
      return plainOfInline(child.content ?? []).trim() || null;
    }
  }
  return null;
}

function plainOfInline(nodes: PmNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text' && typeof n.text === 'string') return n.text;
      if (n.type === 'wikilink') return String(n.attrs?.label ?? n.attrs?.target ?? '');
      if (Array.isArray(n.content)) return plainOfInline(n.content);
      return '';
    })
    .join('');
}

function filenameTitle(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(md|canvas)$/i, '');
}

function readFrontmatterTags(fmJson: string): string[] {
  try {
    const fm = JSON.parse(fmJson) as { tags?: unknown };
    if (!Array.isArray(fm.tags)) return [];
    return fm.tags
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^#/, '').toLowerCase())
      .filter((t) => t.length > 0);
  } catch {
    return [];
  }
}

function isDmOnly(fmJson: string): boolean {
  try {
    const fm = JSON.parse(fmJson) as { dmOnly?: unknown; dm_only?: unknown };
    return fm?.dmOnly === true || fm?.dm_only === true;
  } catch {
    return false;
  }
}

function collectLinksAndTags(doc: PmNode): { wikilinks: string[]; tags: string[] } {
  const links = new Set<string>();
  const tags = new Set<string>();
  walk(doc);
  return { wikilinks: [...links], tags: [...tags] };

  function walk(n: PmNode): void {
    if (n.type === 'wikilink') {
      const target = String(n.attrs?.target ?? '');
      const orphan = Boolean(n.attrs?.orphan);
      links.add(orphan ? `__orphan__:${target}` : target);
    } else if (n.type === 'embedNote') {
      const target = String(n.attrs?.target ?? '');
      if (target) links.add(target);
    } else if (n.type === 'tagMention') {
      const t = String(n.attrs?.tag ?? '').toLowerCase();
      if (t) tags.add(t);
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  }
}
