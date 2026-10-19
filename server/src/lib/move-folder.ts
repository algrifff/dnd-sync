// Folder rename / reparent: the policy around lib/note-paths#renameNotes
// for a whole folder. Used by POST /api/folders/move and the "rename a
// folder via its index.md title" flow. renameNotes carries every Note
// under the folder, its markers and campaign rows, and the wikilinks
// that pointed into it.

import { getDb } from './db';
import { closeDocumentConnections } from '../collab/server';
import { renameNotes } from './note-paths';
import { isHiddenFrom, type Visibility } from './notes';

export type MoveFolderResult =
  | { ok: true; movedCount: number }
  | { ok: false; error: string; reason?: string; path?: string };

/** Rename / reparent a folder. Caller is responsible for permission +
 *  policy checks; this function performs the data move only.
 *
 *  `vis` is the caller's visibility. The folder moves as one unit, so
 *  notes hidden from the caller go with it (leaving them behind would
 *  split the admin's folder in two), but they never count: a folder
 *  holding only hidden notes is `not_found`, and `movedCount` is the
 *  visible notes only. */
export async function moveFolder(args: {
  groupId: string;
  userId: string;
  from: string;
  to: string;
  vis: Visibility;
}): Promise<MoveFolderResult> {
  const { groupId, userId, from, to, vis } = args;
  if (!from || !to) return { ok: false, error: 'invalid_path' };
  if (from === to) return { ok: true, movedCount: 0 };
  if ((to + '/').startsWith(from + '/')) {
    return { ok: false, error: 'cannot_move_into_self' };
  }

  const db = getDb();
  const affected = db
    .query<{ path: string; dm_only: number; gm_only: number }, [string, string, string]>(
      `SELECT path, dm_only, gm_only
         FROM notes
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    )
    .all(groupId, from, from);
  const visibleCount = affected.filter((r) => !isHiddenFrom(r, vis)).length;

  if (visibleCount === 0) {
    const marker = db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM folder_markers WHERE group_id = ? AND path = ?',
      )
      .get(groupId, from);
    if ((marker?.n ?? 0) === 0) return { ok: false, error: 'not_found' };
  }

  const moves = affected.map((r) => ({ from: r.path, to: to + r.path.slice(from.length) }));
  const result = await renameNotes({ groupId, userId, moves, folder: { from, to } });
  if (!result.ok) return { ok: false, error: result.error, path: result.path };

  // Kick live editors for every moved note so they reconnect at the
  // new document name.
  for (const m of moves) await closeDocumentConnections(groupId, m.from);

  return { ok: true, movedCount: visibleCount };
}
