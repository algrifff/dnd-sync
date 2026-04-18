// Post-store derive step. Every time hocuspocus persists a new Y state
// for a note, we regenerate the server-side caches (content_json for
// renderers, content_md for FTS + export, content_text for FTS, links
// for the graph, tags for the index). Synchronous inside the
// transaction — correctness matters more than throughput here; if it
// ever becomes a bottleneck we can debounce per path.

import type * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { getDb } from '@/lib/db';
import { pmToMarkdown } from '@/lib/pm-to-md';
import { extractPlaintext, type PmNode } from '@/lib/md-to-pm';

export function deriveAndPersist(opts: {
  groupId: string;
  path: string;
  doc: Y.Doc;
  userId: string | null;
}): void {
  const pmJson = yDocToProsemirrorJSON(opts.doc, 'default') as unknown as PmNode;

  const title = extractTitle(pmJson) ?? filenameTitle(opts.path);
  const contentText = extractPlaintext(pmJson);
  const contentMd = pmToMarkdown(pmJson);
  const { wikilinks, tags } = collectLinksAndTags(pmJson);

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
              updated_by = COALESCE(?, updated_by)
        WHERE group_id = ? AND path = ?`,
    ).run(
      title,
      JSON.stringify(pmJson),
      contentText,
      contentMd,
      contentMd.length,
      now,
      opts.userId,
      opts.groupId,
      opts.path,
    );

    db.query('DELETE FROM note_links WHERE group_id = ? AND from_path = ?').run(
      opts.groupId,
      opts.path,
    );
    db.query('DELETE FROM tags WHERE group_id = ? AND path = ?').run(
      opts.groupId,
      opts.path,
    );

    const insertLink = db.query(
      `INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)`,
    );
    for (const link of wikilinks) {
      insertLink.run(opts.groupId, opts.path, link);
    }

    const insertTag = db.query(
      `INSERT OR IGNORE INTO tags (group_id, path, tag) VALUES (?, ?, ?)`,
    );
    for (const tag of tags) {
      insertTag.run(opts.groupId, opts.path, tag);
    }
  })();
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
