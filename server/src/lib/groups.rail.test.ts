// The worlds rail data: per-user order and per-world activity signals.
// Activity is gated by the caller's role in each world, so a hidden
// note, asset or Session must never show up through a timestamp or a
// session path.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { listWorldsForSession, setWorldOrder, type WorldRow } from './groups';

type Role = 'admin' | 'editor' | 'viewer';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  for (const table of ['session_notes', 'notes', 'assets', 'sessions', 'group_members']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec("DELETE FROM groups WHERE id != 'default'");
  db.exec('DELETE FROM users');
});

function makeGroup(name: string): string {
  const id = `g_${randomUUID()}`;
  getDb()
    .query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, name, 1);
  return id;
}

function makeUser(): string {
  const id = `u_${randomUUID()}`;
  getDb()
    .query(
      `INSERT INTO users (id, username, password_hash, display_name, accent_color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `user_${id.slice(-8)}`, 'x', 'Tester', '#000000', 1);
  return id;
}

function addMember(groupId: string, userId: string, role: Role, sortOrder: number | null = null): void {
  getDb()
    .query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(groupId, userId, role, 1, sortOrder);
}

function seedNote(
  groupId: string,
  path: string,
  updatedAt: number,
  flags: { dmOnly?: boolean; gmOnly?: boolean } = {},
): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, content_json, content_text,
                          updated_at, created_at, dm_only, gm_only)
       VALUES (?, ?, ?, '{}', '', ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      groupId,
      path,
      updatedAt,
      updatedAt,
      flags.dmOnly ? 1 : 0,
      flags.gmOnly ? 1 : 0,
    );
}

function seedAsset(groupId: string, uploadedAt: number, gmOnly: boolean): void {
  getDb()
    .query(
      `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_at, gm_only)
       VALUES (?, ?, ?, 'image/png', 1, 'a.png', ?, ?)`,
    )
    .run(randomUUID(), groupId, randomUUID(), uploadedAt, gmOnly ? 1 : 0);
}

function seedSession(groupId: string, path: string, status: 'open' | 'closed'): void {
  getDb()
    .query(
      `INSERT INTO session_notes (group_id, note_path, updated_at, status)
       VALUES (?, ?, 1, ?)`,
    )
    .run(groupId, path, status);
}

/** One world with an admin, an editor and a viewer. */
function worldWithRoles(): { groupId: string; users: Record<Role, string> } {
  const groupId = makeGroup('Eberron');
  const users = { admin: makeUser(), editor: makeUser(), viewer: makeUser() };
  for (const role of ['admin', 'editor', 'viewer'] as const) addMember(groupId, users[role], role);
  return { groupId, users };
}

function worldFor(userId: string, groupId: string): WorldRow {
  const world = listWorldsForSession(userId, 'no-session').find((w) => w.id === groupId);
  if (!world) throw new Error('world missing from list');
  return world;
}

describe('world rail order', () => {
  it('should list placed worlds by sort_order, then unplaced ones by name', () => {
    const user = makeUser();
    const alpha = makeGroup('Alpha');
    const bravo = makeGroup('bravo');
    const charlie = makeGroup('Charlie');
    const delta = makeGroup('Delta');
    addMember(delta, user, 'viewer', 0);
    addMember(alpha, user, 'viewer', null);
    addMember(charlie, user, 'viewer', 1);
    addMember(bravo, user, 'viewer', null);

    const names = listWorldsForSession(user, 'no-session').map((w) => w.name);

    expect(names).toEqual(['Delta', 'Charlie', 'Alpha', 'bravo']);
  });

  it('should store the given order and unplace memberships left out', () => {
    const user = makeUser();
    const alpha = makeGroup('Alpha');
    const bravo = makeGroup('Bravo');
    const charlie = makeGroup('Charlie');
    addMember(alpha, user, 'viewer', 0);
    addMember(bravo, user, 'viewer', 1);
    addMember(charlie, user, 'viewer', 2);

    const result = setWorldOrder(user, [charlie, bravo]);

    expect(result).toEqual({ ok: true });
    expect(listWorldsForSession(user, 'no-session').map((w) => w.name)).toEqual([
      'Charlie',
      'Bravo',
      'Alpha',
    ]);
  });

  it('should reject a world the user is not a member of and change nothing', () => {
    const user = makeUser();
    const alpha = makeGroup('Alpha');
    const bravo = makeGroup('Bravo');
    const foreign = makeGroup('Foreign');
    addMember(alpha, user, 'viewer', 0);
    addMember(bravo, user, 'viewer', 1);
    addMember(foreign, makeUser(), 'admin', 0);

    const result = setWorldOrder(user, [bravo, foreign, alpha]);

    expect(result).toEqual({ ok: false, error: 'invalid_world' });
    expect(listWorldsForSession(user, 'no-session').map((w) => w.name)).toEqual([
      'Alpha',
      'Bravo',
    ]);
  });
});

describe('world latestActivityAt', () => {
  it('should ignore a newer dm_only note for a viewer and count it for an editor', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Lore/Open.md', 1_000);
    seedNote(groupId, 'Lore/DmSecret.md', 2_000, { dmOnly: true });

    expect(worldFor(users.viewer, groupId).latestActivityAt).toBe(1_000);
    expect(worldFor(users.editor, groupId).latestActivityAt).toBe(2_000);
  });

  it('should ignore a newer gm_only note for an editor and count it for the admin', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Lore/Open.md', 1_000);
    seedNote(groupId, 'Lore/GmSecret.md', 3_000, { gmOnly: true });

    expect(worldFor(users.editor, groupId).latestActivityAt).toBe(1_000);
    expect(worldFor(users.admin, groupId).latestActivityAt).toBe(3_000);
  });

  it('should count a visible asset upload newer than every note', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Lore/Open.md', 1_000);
    seedAsset(groupId, 4_000, false);

    expect(worldFor(users.viewer, groupId).latestActivityAt).toBe(4_000);
  });

  it('should ignore a newer gm_only asset for an editor and count it for the admin', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Lore/Open.md', 1_000);
    seedAsset(groupId, 5_000, true);

    expect(worldFor(users.editor, groupId).latestActivityAt).toBe(1_000);
    expect(worldFor(users.admin, groupId).latestActivityAt).toBe(5_000);
  });

  it('should be null for a world with nothing the caller can see', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Lore/DmSecret.md', 2_000, { dmOnly: true });

    expect(worldFor(users.viewer, groupId).latestActivityAt).toBeNull();
  });
});

describe('world openSession', () => {
  it('should report the open Session path', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Sessions/S1.md', 1_000);
    seedSession(groupId, 'Sessions/S1.md', 'open');

    expect(worldFor(users.viewer, groupId).openSession).toEqual({ path: 'Sessions/S1.md' });
  });

  it('should be null when every Session is closed', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Sessions/S1.md', 1_000);
    seedSession(groupId, 'Sessions/S1.md', 'closed');

    expect(worldFor(users.admin, groupId).openSession).toBeNull();
  });

  it('should hide an open Session whose note the caller cannot see', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Sessions/Prep.md', 1_000, { dmOnly: true });
    seedSession(groupId, 'Sessions/Prep.md', 'open');

    expect(worldFor(users.viewer, groupId).openSession).toBeNull();
    expect(worldFor(users.editor, groupId).openSession).toEqual({ path: 'Sessions/Prep.md' });
  });

  it('should pick the most recently saved of several open Sessions', () => {
    const { groupId, users } = worldWithRoles();
    seedNote(groupId, 'Sessions/S1.md', 1_000);
    seedNote(groupId, 'Sessions/S2.md', 2_000);
    seedSession(groupId, 'Sessions/S1.md', 'open');
    seedSession(groupId, 'Sessions/S2.md', 'open');

    expect(worldFor(users.viewer, groupId).openSession).toEqual({ path: 'Sessions/S2.md' });
  });
});
