import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import {
  ACCENT_PALETTE,
  createUser,
  DEFAULT_GROUP_ID,
  getUserStorageStats,
  listUsersInGroup,
  revokeUser,
} from './users';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM group_members');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
});

// ── createUser — input validation ──────────────────────────────────────

describe('createUser — validation', () => {
  it('rejects a username that is too short', async () => {
    await expect(
      createUser({ username: 'ab', displayName: 'AB', password: 'validpass', role: 'editor' }),
    ).rejects.toThrow(/3.+32|username/i);
  });

  it('rejects a username that is too long', async () => {
    await expect(
      createUser({
        username: 'a'.repeat(33),
        displayName: 'Long',
        password: 'validpass',
        role: 'editor',
      }),
    ).rejects.toThrow(/3.+32|username/i);
  });

  it('rejects a username with disallowed characters', async () => {
    await expect(
      createUser({ username: 'bad user!', displayName: 'Bad', password: 'validpass', role: 'editor' }),
    ).rejects.toThrow(/username/i);
  });

  it('rejects a password shorter than 8 characters', async () => {
    await expect(
      createUser({ username: 'alice', displayName: 'Alice', password: 'short', role: 'admin' }),
    ).rejects.toThrow(/8 char/i);
  });

  it('rejects a duplicate username (case-insensitive)', async () => {
    await createUser({ username: 'bob', displayName: 'Bob', password: 'password-ok', role: 'editor' });
    await expect(
      createUser({ username: 'BOB', displayName: 'Bob 2', password: 'password-ok', role: 'editor' }),
    ).rejects.toThrow(/already exists/i);
  });

  it('accepts a valid username with hyphens and underscores', async () => {
    const user = await createUser({
      username: 'my-user_42',
      displayName: 'My User',
      password: 'valid-password',
      role: 'editor',
    });
    expect(user.username).toBe('my-user_42');
  });
});

// ── createUser — return shape ──────────────────────────────────────────

describe('createUser — return shape', () => {
  it('returns the correct shape with a generated accent color', async () => {
    const user = await createUser({
      username: 'clara',
      displayName: 'Clara',
      password: 'goodpassword',
      role: 'admin',
    });
    expect(user.id).toBeString();
    expect(user.username).toBe('clara');
    expect(user.displayName).toBe('Clara');
    const paletteStrings: string[] = [...ACCENT_PALETTE];
    expect(paletteStrings).toContain(user.accentColor);
    expect(user.lastLoginAt).toBeNull();
  });

  it('cycles accent colours across users from the palette', async () => {
    const colors: string[] = [];
    for (let i = 0; i < ACCENT_PALETTE.length + 1; i++) {
      const u = await createUser({
        username: `user${i}`,
        displayName: `User ${i}`,
        password: 'goodpassword',
        role: 'viewer',
      });
      colors.push(u.accentColor);
    }
    // Colour at position 0 and at ACCENT_PALETTE.length must be the same (cycle).
    expect(colors[0]).toBe(colors[ACCENT_PALETTE.length]);
  });
});

// ── listUsersInGroup — cross-group isolation ───────────────────────────

describe('listUsersInGroup — cross-group isolation', () => {
  it('only returns members of the specified group', async () => {
    // Create a second group
    const groupB = 'group-b-' + randomUUID().slice(0, 8);
    getDb()
      .query(`INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)`)
      .run(groupB, 'Group B', Date.now());

    const userA = await createUser({
      username: 'userina',
      displayName: 'User In A',
      password: 'passwordok',
      role: 'editor',
      groupId: DEFAULT_GROUP_ID,
    });
    await createUser({
      username: 'userinb',
      displayName: 'User In B',
      password: 'passwordok',
      role: 'viewer',
      groupId: groupB,
    });

    const membersOfA = listUsersInGroup(DEFAULT_GROUP_ID);
    const ids = membersOfA.map((u) => u.id);
    expect(ids).toContain(userA.id);
    expect(ids).not.toContain('userinb');
  });

  it('returns the correct role for each user in the group', async () => {
    await createUser({
      username: 'admin1',
      displayName: 'Admin',
      password: 'passwordok',
      role: 'admin',
    });
    await createUser({
      username: 'viewer1',
      displayName: 'Viewer',
      password: 'passwordok',
      role: 'viewer',
    });

    const members = listUsersInGroup(DEFAULT_GROUP_ID);
    const roles = Object.fromEntries(members.map((u) => [u.username, u.role]));
    expect(roles['admin1']).toBe('admin');
    expect(roles['viewer1']).toBe('viewer');
  });
});

// ── revokeUser ─────────────────────────────────────────────────────────

describe('revokeUser', () => {
  it('removes the user and returns true', async () => {
    const actor = await createUser({
      username: 'admin-x',
      displayName: 'Admin X',
      password: 'passwordok',
      role: 'admin',
    });
    const target = await createUser({
      username: 'target-x',
      displayName: 'Target X',
      password: 'passwordok',
      role: 'viewer',
    });

    const removed = revokeUser(target.id, actor.id, DEFAULT_GROUP_ID);
    expect(removed).toBe(true);
    expect(listUsersInGroup(DEFAULT_GROUP_ID).map((u) => u.id)).not.toContain(target.id);
  });

  it('returns false for a user that does not exist', async () => {
    const actor = await createUser({
      username: 'admin-y',
      displayName: 'Admin Y',
      password: 'passwordok',
      role: 'admin',
    });
    expect(revokeUser('non-existent-id', actor.id, DEFAULT_GROUP_ID)).toBe(false);
  });

  it('is idempotent — second revoke returns false', async () => {
    const actor = await createUser({
      username: 'admin-z',
      displayName: 'Admin Z',
      password: 'passwordok',
      role: 'admin',
    });
    const target = await createUser({
      username: 'target-z',
      displayName: 'Target Z',
      password: 'passwordok',
      role: 'viewer',
    });
    revokeUser(target.id, actor.id, DEFAULT_GROUP_ID);
    expect(revokeUser(target.id, actor.id, DEFAULT_GROUP_ID)).toBe(false);
  });
});

// ── getUserStorageStats ──────────────────────────────────────────────────
//
// Rewritten from per-row correlated subqueries to two GROUP BY
// aggregates joined in application code (see users.ts + migration v47).
// These tests discriminate against the most likely regression from that
// rewrite: bytes from one user's notes/assets leaking into another
// user's total via a bad join/group key.

describe('getUserStorageStats', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM assets');
    db.exec('DELETE FROM notes');
  });

  // notes.created_by / assets.uploaded_by FK-reference users(id). Clean
  // these up here (not just in the next beforeEach) so the outer
  // file-level `DELETE FROM users` doesn't fail with FOREIGN KEY
  // constraint failed against a row this describe block just inserted.
  afterEach(() => {
    const db = getDb();
    db.exec('DELETE FROM assets');
    db.exec('DELETE FROM notes');
  });

  function seedNote(groupId: string, path: string, byteSize: number, createdBy: string): void {
    getDb()
      .query(
        `INSERT INTO notes (id, group_id, path, content_json, content_text, byte_size, updated_at, created_by)
         VALUES (?, ?, ?, '{}', '', ?, ?, ?)`,
      )
      .run(randomUUID(), groupId, path, byteSize, Date.now(), createdBy);
  }

  function seedAsset(groupId: string, size: number, uploadedBy: string): void {
    getDb()
      .query(
        `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, 'image/png', ?, 'x.png', ?, ?)`,
      )
      .run(randomUUID(), groupId, randomUUID(), size, uploadedBy, Date.now());
  }

  it('attributes notes and assets bytes to the correct user, not summed across users', async () => {
    const alice = await createUser({
      username: 'stats-alice',
      displayName: 'Alice',
      password: 'passwordok',
      role: 'editor',
    });
    const bob = await createUser({
      username: 'stats-bob',
      displayName: 'Bob',
      password: 'passwordok',
      role: 'editor',
    });

    seedNote(DEFAULT_GROUP_ID, 'vault/alice-1.md', 100, alice.id);
    seedNote(DEFAULT_GROUP_ID, 'vault/alice-2.md', 250, alice.id);
    seedAsset(DEFAULT_GROUP_ID, 1000, alice.id);

    seedNote(DEFAULT_GROUP_ID, 'vault/bob-1.md', 40, bob.id);
    seedAsset(DEFAULT_GROUP_ID, 500, bob.id);
    seedAsset(DEFAULT_GROUP_ID, 700, bob.id);

    const stats = getUserStorageStats();
    const aliceStats = stats.find((s) => s.userId === alice.id);
    const bobStats = stats.find((s) => s.userId === bob.id);

    expect(aliceStats).toBeDefined();
    expect(aliceStats!.notesBytes).toBe(350);
    expect(aliceStats!.assetsBytes).toBe(1000);
    expect(aliceStats!.totalBytes).toBe(1350);

    expect(bobStats).toBeDefined();
    expect(bobStats!.notesBytes).toBe(40);
    expect(bobStats!.assetsBytes).toBe(1200);
    expect(bobStats!.totalBytes).toBe(1240);
  });

  it('returns zero notesBytes/assetsBytes for a user with none', async () => {
    const carol = await createUser({
      username: 'stats-carol',
      displayName: 'Carol',
      password: 'passwordok',
      role: 'viewer',
    });

    const stats = getUserStorageStats();
    const carolStats = stats.find((s) => s.userId === carol.id);

    expect(carolStats).toBeDefined();
    expect(carolStats!.notesBytes).toBe(0);
    expect(carolStats!.assetsBytes).toBe(0);
    expect(carolStats!.totalBytes).toBe(0);
  });

  it('includes a row for every user, even ones with zero content', async () => {
    const dave = await createUser({
      username: 'stats-dave',
      displayName: 'Dave',
      password: 'passwordok',
      role: 'editor',
    });
    const erin = await createUser({
      username: 'stats-erin',
      displayName: 'Erin',
      password: 'passwordok',
      role: 'editor',
    });
    seedNote(DEFAULT_GROUP_ID, 'vault/dave-1.md', 10, dave.id);

    const ids = getUserStorageStats().map((s) => s.userId);
    expect(ids).toContain(dave.id);
    expect(ids).toContain(erin.id);
  });
});
