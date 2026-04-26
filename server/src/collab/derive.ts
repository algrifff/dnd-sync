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

export function deriveAndPersist(opts: {
  groupId: string;
  path: string;
  doc: Y.Doc;
  userId: string | null;
}): void {
  const pmJson = yDocToProsemirrorJSON(opts.doc, 'default') as unknown as PmNode;

  const yTitle = opts.doc.getText('title').toString().trim();
  const title = yTitle || extractTitle(pmJson) || filenameTitle(opts.path);
  const contentText = extractPlaintext(pmJson);
  const contentMd = pmToMarkdown(pmJson);
  const { wikilinks, tags: inlineTags } = collectLinksAndTags(pmJson);

  const fmRow = getDb()
    .query<{ frontmatter_json: string }, [string, string]>(
      'SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(opts.groupId, opts.path);
  const dmOnly = isDmOnly(fmRow?.frontmatter_json ?? '{}');
  const frontmatterTags = readFrontmatterTags(fmRow?.frontmatter_json ?? '{}');
  const allTags = [...new Set([...inlineTags, ...frontmatterTags])];

  const now = Date.now();
  const db = getDb();
  db.transaction(() => {
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
      title,
      JSON.stringify(pmJson),
      contentText,
      contentMd,
      contentMd.length,
      now,
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
    for (const link of wikilinks) {
      if (link === opts.path) continue; // no self-loops
      insertLink.run(opts.groupId, opts.path, link);
    }

    const insertTag = db.query(
      `INSERT OR IGNORE INTO tags (group_id, path, tag) VALUES (?, ?, ?)`,
    );
    for (const tag of allTags) insertTag.run(opts.groupId, opts.path, tag);
  })();

  // Character + campaign derivation. Runs in its own transaction so
  // a schema failure here can't roll back the note's content update.
  // Both calls are idempotent and cheap no-ops for non-character,
  // non-campaign paths.
  try {
    deriveAllIndexes({
      groupId: opts.groupId,
      notePath: opts.path,
      frontmatterJson: fmRow?.frontmatter_json ?? '{}',
    });
  } catch (err) {
    console.error(`[derive] structured derive failed for ${opts.path}:`, err);
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
