// Group (= world) helpers.
//
// The schema has been multi-tenant-ready since day one; this module
// surfaces the helpers the /api/worlds layer needs: list the worlds
// a user belongs to, create a new world (making the creator an
// admin and seeding its templates / folder skeleton), and switch
// the caller's active world on their session row.

import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { ensureDefaultFolders } from './tree';
import { logAudit } from './audit';

export type WorldRow = {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  isActive: boolean;
};

type ListDbRow = {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  current_group_id: string;
};

export function listWorldsForSession(
  userId: string,
  sessionId: string,
): WorldRow[] {
  const rows = getDb()
    .query<ListDbRow, [string, string]>(
      `SELECT g.id, g.name, gm.role,
              (SELECT s.current_group_id FROM sessions s WHERE s.id = ?) AS current_group_id
         FROM groups g
         JOIN group_members gm ON gm.group_id = g.id
        WHERE gm.user_id = ?
        ORDER BY g.name COLLATE NOCASE`,
    )
    .all(sessionId, userId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    isActive: r.id === r.current_group_id,
  }));
}

/** Set the caller's active world for the rest of the session. Also
 *  verifies the caller is a member of the target world — can't
 *  switch into something you haven't been invited to. */
export function setActiveWorld(
  sessionId: string,
  userId: string,
  groupId: string,
): boolean {
  const db = getDb();
  const member = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(userId, groupId);
  if (!member || member.n === 0) return false;
  db.query('UPDATE sessions SET current_group_id = ? WHERE id = ?').run(
    groupId,
    sessionId,
  );
  return true;
}

/** Create a new world, make the creator its admin, seed the folder
 *  skeleton, and switch the caller into it. Returns the new group's
 *  id. */
export function createWorld(opts: {
  name: string;
  creatorUserId: string;
  sessionId: string;
}): string {
  const name = opts.name.trim();
  if (!name) throw new Error('name is required');
  if (name.length > 80) throw new Error('name too long');

  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.transaction(() => {
    db.query(
      'INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)',
    ).run(id, name, now);
    db.query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at)
       VALUES (?, ?, 'admin', ?)`,
    ).run(id, opts.creatorUserId, now);
    db.query('UPDATE sessions SET current_group_id = ? WHERE id = ?').run(
      id,
      opts.sessionId,
    );
  })();

  // Seed the default folder + campaign skeleton for the new group so
  // it's immediately navigable. Templates are server-global and
  // already present from first boot — no per-group seed there.
  try {
    ensureDefaultFolders(id);
  } catch (err) {
    console.error('[groups] ensureDefaultFolders failed for new world:', err);
  }

  logAudit({
    action: 'group.create',
    actorId: opts.creatorUserId,
    groupId: id,
    target: id,
    details: { name },
  });

  return id;
}
