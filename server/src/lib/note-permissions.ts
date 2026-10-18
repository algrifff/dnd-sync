// Who may edit a Note. One rule shared by the collab server (read-only
// connections) and the HTTP routes that edit a Note's connections
// (docs/adr/0003-connections-panel-and-manual-relationships.md).

import { getDb } from '@/lib/db';
import { isPcOwnedBy } from '@/lib/characters';
import type { Session } from '@/lib/session';

/** True for the two doc families that do NOT back onto a `notes` row:
 *  ephemeral `.`-channels (`.presence:<id>`, `.graph-state:<id>`) and
 *  the persistent `graph-groups:<id>` doc. Takes a BARE path. */
export function isNonNoteDoc(path: string): boolean {
  return path.startsWith('.') || path.startsWith('graph-groups:');
}

/** Return true when the given session should be allowed to write to
 *  the given hocuspocus document. Used to flip connections to
 *  read-only so a viewer can still join the collab session and see
 *  everyone else's updates without being able to push their own.
 *
 *    - admin / editor: full edit everywhere.
 *    - viewer: edit on notes they created, on a PC they own
 *      (frontmatter player: matches their username), OR on any
 *      Session log, which the whole table co-writes.
 *    - ephemeral `.`-docs (presence, graph-state): editor/admin
 *      only so viewers don't write pins/colours. Awareness
 *      (cursors) still broadcasts under read-only.
 *    - `graph-groups:<id>`: editor/admin only — it's DM-configured
 *      colour grouping, not a per-user thing.
 *
 *  `path` is the BARE note path — the caller has already stripped the
 *  group prefix and asserted it matches the session. */
export function canEditDoc(path: string, session: Session): boolean {
  if (session.role === 'admin' || session.role === 'editor') return true;

  // Viewer path below.
  if (isNonNoteDoc(path)) return false;

  const db = getDb();
  const note = db
    .query<{ created_by: string | null; kind: string | null }, [string, string]>(
      `SELECT created_by,
              CASE WHEN json_valid(frontmatter_json)
                   THEN json_extract(frontmatter_json, '$.kind') END AS kind
         FROM notes WHERE group_id = ? AND path = ?`,
    )
    .get(session.currentGroupId, path);
  if (note && note.created_by === session.userId) return true;
  if (note && note.kind === 'session') return true;
  if (isPcOwnedBy(session.currentGroupId, path, session.userId)) {
    return true;
  }
  return false;
}
