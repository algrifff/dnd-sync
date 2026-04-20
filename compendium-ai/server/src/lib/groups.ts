// Group (= world) helpers.
//
// The schema has been multi-tenant-ready since day one; this module
// surfaces the helpers the /api/worlds layer needs: list the worlds
// a user belongs to, create a new world (making the creator an
// admin and seeding its templates / folder skeleton), switch the
// caller's active world, delete a world, and manage invite tokens.

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

/**
 * Delete a world and all its data (cascades via FK). Refuses if it
 * is the caller's only world — they'd be left with nowhere to go.
 * Returns the id of another world to switch into, or null if the
 * session was already in a different world.
 */
export function deleteWorld(opts: {
  groupId: string;
  actorId: string;
  sessionId: string;
}): { switchToId: string | null } {
  const db = getDb();

  // Ensure caller is admin of this world.
  const role = db
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(opts.actorId, opts.groupId);
  if (!role || role.role !== 'admin') throw new Error('forbidden');

  // Refuse if this is the caller's only world.
  const otherWorld = db
    .query<{ id: string }, [string, string]>(
      `SELECT g.id FROM groups g
         JOIN group_members gm ON gm.group_id = g.id
        WHERE gm.user_id = ? AND g.id != ?
        LIMIT 1`,
    )
    .get(opts.actorId, opts.groupId);
  if (!otherWorld) throw new Error('last_world');

  // If any session is currently in this world, redirect it.
  db.transaction(() => {
    db.query(
      `UPDATE sessions SET current_group_id = ?
        WHERE current_group_id = ?`,
    ).run(otherWorld.id, opts.groupId);

    db.query('DELETE FROM groups WHERE id = ?').run(opts.groupId);
  })();

  logAudit({
    action: 'group.delete',
    actorId: opts.actorId,
    groupId: otherWorld.id,
    target: opts.groupId,
    details: {},
  });

  // Tell the caller whether their own session was redirected.
  const mySession = db
    .query<{ current_group_id: string }, [string]>(
      'SELECT current_group_id FROM sessions WHERE id = ?',
    )
    .get(opts.sessionId);
  const switched = mySession?.current_group_id === otherWorld.id;
  return { switchToId: switched ? otherWorld.id : null };
}

/** Upsert an invite token for a world (one active token per world).
 *  Replaces any existing token so old links stop working. */
export function createInviteToken(opts: {
  groupId: string;
  createdBy: string;
}): string {
  const token = randomUUID();
  const db = getDb();
  db.transaction(() => {
    db.query('DELETE FROM group_invite_tokens WHERE group_id = ?').run(
      opts.groupId,
    );
    db.query(
      `INSERT INTO group_invite_tokens (token, group_id, created_by, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(token, opts.groupId, opts.createdBy, Date.now());
  })();
  return token;
}

/** Look up the active invite token for a world, if any. */
export function getInviteToken(groupId: string): string | null {
  const row = getDb()
    .query<{ token: string }, [string]>(
      'SELECT token FROM group_invite_tokens WHERE group_id = ?',
    )
    .get(groupId);
  return row?.token ?? null;
}

type AcceptResult =
  | { ok: true; groupId: string; groupName: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_member' };

/** Consume an invite token and add the user to the world. */
export function acceptInvite(opts: {
  token: string;
  userId: string;
  sessionId: string;
}): AcceptResult {
  const db = getDb();
  const row = db
    .query<{ group_id: string; expires_at: number | null }, [string]>(
      'SELECT group_id, expires_at FROM group_invite_tokens WHERE token = ?',
    )
    .get(opts.token);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.expires_at != null && row.expires_at < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const group = db
    .query<{ name: string }, [string]>('SELECT name FROM groups WHERE id = ?')
    .get(row.group_id);
  if (!group) return { ok: false, reason: 'not_found' };

  const existing = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(opts.userId, row.group_id);
  if (existing && existing.n > 0) {
    // Already a member — just switch into that world.
    db.query('UPDATE sessions SET current_group_id = ? WHERE id = ?').run(
      row.group_id,
      opts.sessionId,
    );
    return { ok: true, groupId: row.group_id, groupName: group.name };
  }

  db.transaction(() => {
    db.query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at)
       VALUES (?, ?, 'editor', ?)`,
    ).run(row.group_id, opts.userId, Date.now());
    db.query('UPDATE sessions SET current_group_id = ? WHERE id = ?').run(
      row.group_id,
      opts.sessionId,
    );
  })();

  logAudit({
    action: 'group.join',
    actorId: opts.userId,
    groupId: row.group_id,
    target: opts.userId,
    details: { via: 'invite_token' },
  });

  return { ok: true, groupId: row.group_id, groupName: group.name };
}
