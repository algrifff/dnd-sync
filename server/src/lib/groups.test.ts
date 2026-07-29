// deleteWorld() cross-tenant regression coverage.
//
// H4 (security audit finding): the previous implementation resolved the
// post-delete fallback world from the DELETING ADMIN's own memberships
// and repointed EVERY session that was pointed at the deleted world at
// that admin-derived world — including sessions belonging to other
// members who may not be members of the admin's fallback world at all.
// Because loadSessionRowById() LEFT JOINs group_members and shapeSession()
// defaults a missing role to 'viewer', and no data route re-checks
// membership against session.currentGroupId, this silently handed
// affected members a valid session with cross-tenant read access to a
// world they never joined.
//
// These tests build two members with genuinely DIFFERENT fallback
// worlds (the admin's vs. an unrelated member's own other world) so a
// regression to the admin-derived fallback is caught, and cover the
// "member has zero remaining worlds" edge case, which the NOT NULL +
// FK'd sessions.current_group_id column means must end in a destroyed
// session rather than a null/dangling one.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { deleteWorld } from './groups';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  // Order matters: sessions, group_members, and audit_log all reference
  // groups/users, so delete them first or FK_CONSTRAINT_FAILED.
  // deleteWorld() itself writes an audit_log row (group.delete) pointing
  // at the fallback world, which has no ON DELETE CASCADE — so a prior
  // test's audit rows must be cleared before this beforeEach can drop
  // that prior test's groups. The seeded 'default' world is kept to
  // satisfy the built-in admin session's FK.
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM group_members');
  db.exec('DELETE FROM audit_log');
  db.exec("DELETE FROM groups WHERE id != 'default'");
  db.exec('DELETE FROM users');
});

function makeGroup(name: string): string {
  const id = `g_${randomUUID()}`;
  getDb()
    .query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, name, Date.now());
  return id;
}

function makeUser(label: string): string {
  const id = `u_${randomUUID()}`;
  getDb()
    .query(
      `INSERT INTO users (id, username, password_hash, display_name, accent_color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `user_${id.slice(-8)}`, 'x', label, '#000000', Date.now());
  return id;
}

function addMember(
  groupId: string,
  userId: string,
  role: 'admin' | 'editor' | 'viewer' = 'editor',
): void {
  getDb()
    .query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(groupId, userId, role, Date.now());
}

function makeSession(userId: string, groupId: string): string {
  const id = `s_${randomUUID()}`;
  getDb()
    .query(
      `INSERT INTO sessions (id, user_id, current_group_id, csrf_token,
                             created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, groupId, 'csrf', Date.now(), Date.now(), Date.now() + 86_400_000);
  return id;
}

function sessionGroupId(sessionId: string): string | null {
  const row = getDb()
    .query<{ current_group_id: string }, [string]>(
      'SELECT current_group_id FROM sessions WHERE id = ?',
    )
    .get(sessionId);
  return row?.current_group_id ?? null;
}

function sessionExists(sessionId: string): boolean {
  const row = getDb()
    .query<{ id: string }, [string]>('SELECT id FROM sessions WHERE id = ?')
    .get(sessionId);
  return row != null;
}

describe('deleteWorld', () => {
  it('throws forbidden when the actor is not an admin of the world', () => {
    const worldA = makeGroup('World A');
    const actor = makeUser('Actor');
    addMember(worldA, actor, 'editor');
    const sessionId = makeSession(actor, worldA);

    expect(() => deleteWorld({ groupId: worldA, actorId: actor, sessionId })).toThrow(
      'forbidden',
    );
  });

  it("throws last_world when it is the actor's only world", () => {
    const worldA = makeGroup('World A');
    const actor = makeUser('Actor');
    addMember(worldA, actor, 'admin');
    const sessionId = makeSession(actor, worldA);

    expect(() => deleteWorld({ groupId: worldA, actorId: actor, sessionId })).toThrow(
      'last_world',
    );
  });

  it("repoints an affected member's session to a world THAT MEMBER belongs to, not the deleting admin's fallback world", () => {
    const worldA = makeGroup('World A (deleted)');
    const worldB = makeGroup("Admin's other world");
    const worldC = makeGroup("Member's own other world");

    const admin = makeUser('Admin');
    addMember(worldA, admin, 'admin');
    addMember(worldB, admin, 'admin');
    const adminSession = makeSession(admin, worldA);

    // This member is NOT in worldB (the admin's fallback) at all — only
    // in worldA (being deleted) and worldC (their own separate world).
    const member = makeUser('Member');
    addMember(worldA, member, 'editor');
    addMember(worldC, member, 'editor');
    const memberSession = makeSession(member, worldA);

    deleteWorld({ groupId: worldA, actorId: admin, sessionId: adminSession });

    expect(sessionGroupId(memberSession)).toBe(worldC);
  });

  it('destroys (logs out) the session of a member left with zero remaining worlds, instead of repointing it anywhere', () => {
    const worldA = makeGroup('World A (deleted)');
    const worldB = makeGroup("Admin's other world");

    const admin = makeUser('Admin');
    addMember(worldA, admin, 'admin');
    addMember(worldB, admin, 'admin');
    const adminSession = makeSession(admin, worldA);

    // Orphan's only membership is worldA — nowhere left to go.
    const orphan = makeUser('Orphan');
    addMember(worldA, orphan, 'viewer');
    const orphanSession = makeSession(orphan, worldA);

    deleteWorld({ groupId: worldA, actorId: admin, sessionId: adminSession });

    expect(sessionExists(orphanSession)).toBe(false);
  });

  it("switches the caller's own session to a world they belong to and reports it via switchToId", () => {
    const worldA = makeGroup('World A (deleted)');
    const worldB = makeGroup('World B');

    const admin = makeUser('Admin');
    addMember(worldA, admin, 'admin');
    addMember(worldB, admin, 'admin');
    const adminSession = makeSession(admin, worldA);

    const result = deleteWorld({ groupId: worldA, actorId: admin, sessionId: adminSession });

    expect(result.switchToId).toBe(worldB);
    expect(sessionGroupId(adminSession)).toBe(worldB);
  });

  it("leaves switchToId null and the session untouched when the caller's own session was already in a different world", () => {
    const worldA = makeGroup('World A (deleted)');
    const worldB = makeGroup('World B');

    const admin = makeUser('Admin');
    addMember(worldA, admin, 'admin');
    addMember(worldB, admin, 'admin');
    const adminSession = makeSession(admin, worldB); // already elsewhere

    const result = deleteWorld({ groupId: worldA, actorId: admin, sessionId: adminSession });

    expect(result.switchToId).toBeNull();
    expect(sessionGroupId(adminSession)).toBe(worldB);
  });

  it('removes the group row itself after delete', () => {
    const worldA = makeGroup('World A (deleted)');
    const worldB = makeGroup('World B');

    const admin = makeUser('Admin');
    addMember(worldA, admin, 'admin');
    addMember(worldB, admin, 'admin');
    const adminSession = makeSession(admin, worldA);

    deleteWorld({ groupId: worldA, actorId: admin, sessionId: adminSession });

    const group = getDb()
      .query<{ id: string }, [string]>('SELECT id FROM groups WHERE id = ?')
      .get(worldA);
    expect(group).toBeFalsy();
  });
});
