// Per-friend tokens. Each row is a named player with their own long-lived
// token — revocable individually without disturbing the rest.

import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db';

export type Friend = {
  id: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
};

export type FriendWithToken = Friend & { token: string };

function genToken(): string {
  return randomBytes(24).toString('hex');
}

function friendFromRow(row: {
  id: string;
  name: string;
  created_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
}): Friend {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function listFriends(): Friend[] {
  return getDb()
    .query<
      {
        id: string;
        name: string;
        created_at: number;
        revoked_at: number | null;
        last_seen_at: number | null;
      },
      []
    >(
      `SELECT id, name, created_at, revoked_at, last_seen_at
         FROM friends
         ORDER BY revoked_at IS NULL DESC, created_at DESC`,
    )
    .all()
    .map(friendFromRow);
}

/** Admin-only variant that includes active friends' tokens so the dashboard
 *  can expose them for manual plugin configuration. Revoked rows omitted. */
export function listActiveFriendsWithTokens(): FriendWithToken[] {
  return getDb()
    .query<
      {
        id: string;
        name: string;
        token: string;
        created_at: number;
        revoked_at: number | null;
        last_seen_at: number | null;
      },
      []
    >(
      `SELECT id, name, token, created_at, revoked_at, last_seen_at
         FROM friends
         WHERE revoked_at IS NULL
         ORDER BY created_at DESC`,
    )
    .all()
    .map((row) => ({ ...friendFromRow(row), token: row.token }));
}

export function createFriend(name: string): FriendWithToken {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('friend name is required');
  const id = randomUUID();
  const token = genToken();
  const now = Date.now();
  getDb()
    .query(
      'INSERT INTO friends (id, name, token, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
    )
    .run(id, trimmed, token, now);
  return { id, name: trimmed, token, createdAt: now, revokedAt: null, lastSeenAt: null };
}

export function revokeFriend(id: string): boolean {
  const res = getDb()
    .query('UPDATE friends SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), id);
  return Number(res.changes) > 0;
}

export function getFriendById(id: string): FriendWithToken | null {
  const row = getDb()
    .query<
      {
        id: string;
        name: string;
        token: string;
        created_at: number;
        revoked_at: number | null;
        last_seen_at: number | null;
      },
      [string]
    >(
      `SELECT id, name, token, created_at, revoked_at, last_seen_at
         FROM friends WHERE id = ? AND revoked_at IS NULL`,
    )
    .get(id);
  if (!row) return null;
  return { ...friendFromRow(row), token: row.token };
}

/** Bump last_seen_at for a friend token, if it matches one. Called on every
 *  successful WebSocket connection so the admin dashboard can show whether
 *  a paired friend has actually connected. This is a best-effort probe —
 *  any error is logged and swallowed; a failed heartbeat must NEVER tear
 *  down a healthy WebSocket connection. */
export function touchFriendLastSeen(token: string | null): void {
  if (!token) return;
  try {
    getDb()
      .query('UPDATE friends SET last_seen_at = ? WHERE token = ? AND revoked_at IS NULL')
      .run(Date.now(), token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Expected when migration v5 hasn't run yet. Silent.
    if (/no such table: friends|no such column: last_seen_at/i.test(msg)) return;
    // Anything else: log but don't propagate — the caller is on the WS hot
    // path and losing the connection over a heartbeat is far worse than a
    // stale timestamp.
    console.warn('[compendium] touchFriendLastSeen failed (ignored):', msg);
  }
}

/**
 * Returns true if the bearer token matches any non-revoked friend.
 * Tolerates the missing-table case (migration v3 not yet applied) by
 * returning false so the shared player_token path stays operational;
 * any other DB error still propagates.
 */
export function isFriendToken(token: string): boolean {
  try {
    const row = getDb()
      .query<{ cnt: number }, [string]>(
        'SELECT COUNT(*) AS cnt FROM friends WHERE token = ? AND revoked_at IS NULL',
      )
      .get(token);
    return (row?.cnt ?? 0) > 0;
  } catch (err) {
    if (err instanceof Error && /no such table: friends/i.test(err.message)) {
      return false;
    }
    throw err;
  }
}
