import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import {
  clearWorldIcon,
  isGroupMember,
  listWorldsForSession,
  loadWorldIcon,
  setWorldIcon,
} from './groups';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

let groupId: string;
let userId: string;
let sessionId: string;

beforeEach(() => {
  const db = getDb();
  // Order matters: sessions and group_members reference users/groups,
  // so delete them first or FK_CONSTRAINT_FAILED. The seeded 'default'
  // world is kept to satisfy the built-in admin session's FK.
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM group_members');
  db.exec("DELETE FROM groups WHERE id != 'default'");
  db.exec('DELETE FROM users');

  groupId = `g_${randomUUID()}`;
  userId = `u_${randomUUID()}`;
  sessionId = `s_${randomUUID()}`;

  db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
    groupId,
    'Iconless World',
    Date.now(),
  );
  db.query(
    `INSERT INTO users (id, username, password_hash, display_name, accent_color, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, `user_${userId.slice(-6)}`, 'x', 'Tester', '#000000', Date.now());
  db.query(
    `INSERT INTO group_members (group_id, user_id, role, joined_at)
     VALUES (?, ?, 'admin', ?)`,
  ).run(groupId, userId, Date.now());
  db.query(
    `INSERT INTO sessions (id, user_id, current_group_id, csrf_token,
                           created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    groupId,
    'csrf',
    Date.now(),
    Date.now(),
    Date.now() + 86_400_000,
  );
});

describe('world icon blob helpers', () => {
  it('starts with iconVersion 0 and loadWorldIcon returning null', () => {
    expect(loadWorldIcon(groupId)).toBeNull();
    const worlds = listWorldsForSession(userId, sessionId);
    const row = worlds.find((w) => w.id === groupId);
    expect(row?.iconVersion).toBe(0);
  });

  it('setWorldIcon persists bytes + mime and bumps iconVersion', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const before = Date.now();
    // Small sleep to guarantee a strictly increasing timestamp against
    // a later overwrite even on machines with ms-precision clocks.
    await new Promise((r) => setTimeout(r, 2));
    const v = setWorldIcon(groupId, bytes, 'image/webp');
    expect(v).toBeGreaterThanOrEqual(before);

    const loaded = loadWorldIcon(groupId);
    expect(loaded).not.toBeNull();
    expect(loaded!.mime).toBe('image/webp');
    expect(Array.from(loaded!.blob)).toEqual([1, 2, 3, 4, 5]);
    expect(loaded!.updatedAt).toBe(v);

    const worlds = listWorldsForSession(userId, sessionId);
    expect(worlds.find((w) => w.id === groupId)?.iconVersion).toBe(v);
  });

  it('overwriting produces a new iconVersion and new bytes', async () => {
    const v1 = setWorldIcon(groupId, new Uint8Array([9]), 'image/png');
    await new Promise((r) => setTimeout(r, 2));
    const v2 = setWorldIcon(groupId, new Uint8Array([42, 99]), 'image/jpeg');
    expect(v2).toBeGreaterThan(v1);

    const loaded = loadWorldIcon(groupId);
    expect(loaded!.mime).toBe('image/jpeg');
    expect(Array.from(loaded!.blob)).toEqual([42, 99]);
  });

  it('clearWorldIcon removes bytes and resets iconVersion to 0', () => {
    setWorldIcon(groupId, new Uint8Array([1, 2, 3]), 'image/webp');
    clearWorldIcon(groupId);

    expect(loadWorldIcon(groupId)).toBeNull();
    const worlds = listWorldsForSession(userId, sessionId);
    expect(worlds.find((w) => w.id === groupId)?.iconVersion).toBe(0);
  });

  it('isGroupMember gates the serve route correctly', () => {
    expect(isGroupMember(userId, groupId)).toBe(true);

    const strangerId = `u_${randomUUID()}`;
    getDb()
      .query(
        `INSERT INTO users (id, username, password_hash, display_name, accent_color, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        strangerId,
        `stranger_${strangerId.slice(-6)}`,
        'x',
        'Stranger',
        '#000',
        Date.now(),
      );
    expect(isGroupMember(strangerId, groupId)).toBe(false);
  });
});
