// Folder rename / reparent core. Walks every note + folder marker
// under `from`, rewrites paths to sit under `to`, then propagates the
// change to derived tables (note_links, tags, aliases, characters,
// session_notes, items, locations, creatures, campaigns), the FTS
// mirror, and any wikilink targets that pointed at the old prefix.
//
// Extracted from the original POST /api/folders/move handler so the
// "rename a folder via its index.md title" flow can reuse the same
// logic without duplicating the transaction. The wikilink rewrite
// pass (rewriteWikilinksForRenames) is deliberately included here so
// every folder-rename codepath updates `[[Characters]]` →
// `[[Party Members]]` consistently — the previous folders/move route
// missed that step and was the bug this module was extracted to fix.

import { getDb } from './db';
import { closeDocumentConnections } from '../collab/server';
import {
  findWikilinkLinkers,
  rewriteWikilinksForLinkers,
  type Rename,
} from './move-rewrite';
import { deriveFolderIndexesFor } from './campaign-index';

export type MoveFolderResult =
  | { ok: true; movedCount: number; renames: Rename[] }
  | { ok: false; error: string; reason?: string; path?: string };

/** Slugify a single segment for use as a campaigns.slug. Mirrors the
 *  inline helper that previously lived in /api/folders/move. */
function slugifySegment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Rename / reparent a folder. Caller is responsible for permission +
 *  policy checks; this function performs the data move only. */
export async function moveFolder(args: {
  groupId: string;
  userId: string;
  from: string;
  to: string;
}): Promise<MoveFolderResult> {
  const { groupId, userId, from, to } = args;
  if (!from || !to) return { ok: false, error: 'invalid_path' };
  if (from === to) return { ok: true, movedCount: 0, renames: [] };
  if ((to + '/').startsWith(from + '/')) {
    return { ok: false, error: 'cannot_move_into_self' };
  }

  const db = getDb();

  const affected = db
    .query<
      { path: string; title: string; content_text: string },
      [string, string, string]
    >(
      `SELECT path, title, content_text
         FROM notes
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    )
    .all(groupId, from, from);

  if (affected.length === 0) {
    const marker = db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM folder_markers WHERE group_id = ? AND path = ?',
      )
      .get(groupId, from);
    if ((marker?.n ?? 0) === 0) return { ok: false, error: 'not_found' };
  }

  const moved = affected.map((r) => ({
    from: r.path,
    to: to + r.path.slice(from.length),
    title: r.title,
    content: r.content_text,
  }));

  for (const m of moved) {
    const clash = db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, m.to);
    if ((clash?.n ?? 0) > 0) {
      return { ok: false, error: 'exists', path: m.to };
    }
  }

  // Folder-path renames: in addition to every moved NOTE, the folder
  // path itself is a valid wikilink target (e.g. `[[Characters]]`
  // resolves to the folder, not its index.md). Synthesise those so
  // the wikilink rewriter rewrites bare-folder targets too. Includes
  // the top-level folder + every nested folder marker under it.
  const folderRenames: Rename[] = [{ from, to }];
  const subMarkers = db
    .query<{ path: string }, [string, string]>(
      `SELECT DISTINCT path FROM folder_markers
        WHERE group_id = ? AND path LIKE ? || '/%'`,
    )
    .all(groupId, from);
  for (const mk of subMarkers) {
    folderRenames.push({ from: mk.path, to: to + mk.path.slice(from.length) });
  }

  // Capture the linker set BEFORE the transaction. Once the move
  // rewrites note_links.to_path in place, the discovery query in
  // findWikilinkLinkers would find nothing — the edges already point
  // at the new paths. The body-rewrite pass below uses this list to
  // walk each linker's content_json after the transaction commits.
  const fromPaths = [
    ...moved.map((m) => m.from),
    ...folderRenames.map((r) => r.from),
  ];
  const linkers = findWikilinkLinkers(groupId, fromPaths)
    // Drop linkers that are themselves being moved — their bodies
    // will follow their new path; rewriting wikilinks inside the
    // moved subtree is a no-op (their internal targets get rewritten
    // by the same pass below regardless).
    .filter((p) => !moved.some((m) => m.from === p));

  db.transaction(() => {
    db.exec('PRAGMA defer_foreign_keys = 1');
    const movedAt = Date.now();
    for (const m of moved) {
      db.query('UPDATE notes SET path = ?, updated_at = ? WHERE group_id = ? AND path = ?').run(
        m.to,
        movedAt,
        groupId,
        m.from,
      );
      db.query(
        'UPDATE note_links SET from_path = ? WHERE group_id = ? AND from_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE note_links SET to_path = ? WHERE group_id = ? AND to_path = ?',
      ).run(m.to, groupId, m.from);
      db.query('UPDATE tags SET path = ? WHERE group_id = ? AND path = ?').run(
        m.to,
        groupId,
        m.from,
      );
      db.query('UPDATE aliases SET path = ? WHERE group_id = ? AND path = ?').run(
        m.to,
        groupId,
        m.from,
      );
      db.query(
        'UPDATE characters SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE character_campaigns SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE session_notes SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE items SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE locations SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE creatures SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE locations SET parent_path = ? WHERE group_id = ? AND parent_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE users SET active_character_path = ? WHERE active_character_path = ?',
      ).run(m.to, m.from);
      db.query('DELETE FROM notes_fts WHERE path = ? AND group_id = ?').run(
        m.from,
        groupId,
      );
      db.query(
        'INSERT INTO notes_fts(path, group_id, title, content) VALUES (?, ?, ?, ?)',
      ).run(m.to, groupId, m.title, m.content);
    }

    const markers = db
      .query<{ path: string }, [string, string, string]>(
        `SELECT path FROM folder_markers
          WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
      )
      .all(groupId, from, from);
    for (const mk of markers) {
      const next = to + mk.path.slice(from.length);
      db.query(
        'DELETE FROM folder_markers WHERE group_id = ? AND path = ?',
      ).run(groupId, next);
      db.query(
        'UPDATE folder_markers SET path = ? WHERE group_id = ? AND path = ?',
      ).run(next, groupId, mk.path);
    }

    const campaigns = db
      .query<
        { slug: string; folder_path: string; name: string },
        [string, string, string]
      >(
        `SELECT slug, folder_path, name FROM campaigns
          WHERE group_id = ? AND (folder_path = ? OR folder_path LIKE ? || '/%')`,
      )
      .all(groupId, from, from);
    for (const c of campaigns) {
      const nextPath = to + c.folder_path.slice(from.length);
      const nextSlug = slugifySegment(nextPath.split('/').pop() ?? c.slug);
      db.query(
        'DELETE FROM campaigns WHERE group_id = ? AND slug = ? AND slug != ?',
      ).run(groupId, nextSlug, c.slug);
      db.query(
        `UPDATE campaigns
            SET folder_path = ?,
                slug = ?
          WHERE group_id = ? AND slug = ?`,
      ).run(nextPath, nextSlug, groupId, c.slug);
      if (nextSlug !== c.slug) {
        db.query(
          'UPDATE character_campaigns SET campaign_slug = ? WHERE group_id = ? AND campaign_slug = ?',
        ).run(nextSlug, groupId, c.slug);
        db.query(
          'UPDATE session_notes SET campaign_slug = ? WHERE group_id = ? AND campaign_slug = ?',
        ).run(nextSlug, groupId, c.slug);
        // groups.active_campaign_slug pins the world's default
        // campaign — without this update the rename would silently
        // unpin the active campaign because the slug it referenced
        // no longer exists.
        db.query(
          'UPDATE groups SET active_campaign_slug = ? WHERE id = ? AND active_campaign_slug = ?',
        ).run(nextSlug, groupId, c.slug);
      }
    }
  })();

  // Kick live editors for every moved note so they reconnect at the
  // new document name.
  for (const m of moved) {
    await closeDocumentConnections(m.from);
  }

  // Rewrite wikilink targets in every linker that pointed at any of
  // the renamed paths. Linkers were collected pre-transaction (see
  // above); the body rewrite + note_links cleanup happens here using
  // the new paths. Without this pass, `[[Characters]]` would stay
  // pointing at the old path even after the folder moved to
  // `Party Members`.
  const renames: Rename[] = [
    ...moved.map((m) => ({ from: m.from, to: m.to })),
    ...folderRenames,
  ];
  if (renames.length > 0 && linkers.length > 0) {
    try {
      const touched = rewriteWikilinksForLinkers(groupId, linkers, renames);
      for (const linker of touched) await closeDocumentConnections(linker);
    } catch (err) {
      console.error('[move-folder] wikilink rewrite failed:', err);
    }
  }

  // Refresh auto-managed indexes for every folder touched. Include the
  // move endpoints themselves so the CONTAINER folders pick up the
  // appearance/disappearance of the moved subtree.
  const touchedPaths: string[] = [from, to];
  for (const m of moved) {
    touchedPaths.push(m.from, m.to);
  }
  await deriveFolderIndexesFor(groupId, touchedPaths, { userId });

  return { ok: true, movedCount: moved.length, renames };
}
