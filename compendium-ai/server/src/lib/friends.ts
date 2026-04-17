// Per-friend tokens. Each row is a named player with their own long-lived
// token — revocable individually without disturbing the rest.

import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db';

export type Friend = {
  id: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
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
}): Friend {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function listFriends(): Friend[] {
  return getDb()
    .query<
      { id: string; name: string; created_at: number; revoked_at: number | null },
      []
    >(
      `SELECT id, name, created_at, revoked_at
         FROM friends
         ORDER BY revoked_at IS NULL DESC, created_at DESC`,
    )
    .all()
    .map(friendFromRow);
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
  return { id, name: trimmed, token, createdAt: now, revokedAt: null };
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
      },
      [string]
    >(
      `SELECT id, name, token, created_at, revoked_at
         FROM friends WHERE id = ? AND revoked_at IS NULL`,
    )
    .get(id);
  if (!row) return null;
  return { ...friendFromRow(row), token: row.token };
}

/** Returns true if the bearer token matches any non-revoked friend. */
export function isFriendToken(token: string): boolean {
  const row = getDb()
    .query<{ cnt: number }, [string]>(
      'SELECT COUNT(*) AS cnt FROM friends WHERE token = ? AND revoked_at IS NULL',
    )
    .get(token);
  return (row?.cnt ?? 0) > 0;
}
