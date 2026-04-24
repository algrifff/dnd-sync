import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { createUser } from './users';
import {
  createUserCharacter,
  deleteUserCharacter,
  getUserCharacter,
  listUserCharacters,
  updateUserCharacter,
} from './userCharacters';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM user_character_bindings');
  db.exec('DELETE FROM user_characters');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM group_members');
  db.exec('DELETE FROM users');
});

async function seedUser(username = 'alex'): Promise<string> {
  const u = await createUser({
    username,
    displayName: username,
    password: 'password123',
    role: 'editor',
  });
  return u.id;
}

describe('createUserCharacter', () => {
  it('creates a user-level character with trimmed name and sheet defaults', async () => {
    const userId = await seedUser();
    const uc = createUserCharacter(userId, { name: '  Bob  ' });
    expect(uc.ownerUserId).toBe(userId);
    expect(uc.name).toBe('Bob');
    expect(uc.kind).toBe('character');
    expect(uc.sheet.name).toBe('Bob');
  });

  it('rejects an empty name', async () => {
    const userId = await seedUser();
    expect(() => createUserCharacter(userId, { name: '  ' })).toThrow(/name/);
  });

  it('persists portrait URL when provided', async () => {
    const userId = await seedUser();
    const uc = createUserCharacter(userId, {
      name: 'Bob',
      portraitUrl: 'https://example.com/bob.png',
    });
    const fetched = getUserCharacter(uc.id, userId);
    expect(fetched?.portraitUrl).toBe('https://example.com/bob.png');
  });
});

describe('listUserCharacters', () => {
  it('returns only characters owned by the requesting user', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    createUserCharacter(alice, { name: 'AlicePC' });
    createUserCharacter(bob, { name: 'BobPC' });

    const aliceList = listUserCharacters(alice);
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]!.name).toBe('AlicePC');
  });

  it('orders by updated_at desc', async () => {
    const userId = await seedUser();
    const first = createUserCharacter(userId, { name: 'First' });
    createUserCharacter(userId, { name: 'Second' });
    // Bump First's updated_at so it sorts to the top
    await new Promise((r) => setTimeout(r, 5));
    updateUserCharacter(first.id, userId, { sheet: { note: 'touched' } });

    const list = listUserCharacters(userId);
    expect(list[0]!.name).toBe('First');
  });
});

describe('getUserCharacter', () => {
  it('returns null when the requester is not the owner', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const uc = createUserCharacter(alice, { name: 'AlicePC' });
    expect(getUserCharacter(uc.id, bob)).toBeNull();
  });
});

describe('updateUserCharacter', () => {
  it('shallow-merges sheet patches', async () => {
    const userId = await seedUser();
    const uc = createUserCharacter(userId, {
      name: 'Bob',
      sheet: { class: 'Fighter', level: 3 },
    });
    const updated = updateUserCharacter(uc.id, userId, {
      sheet: { level: 4 },
    });
    expect(updated?.sheet.class).toBe('Fighter');
    expect(updated?.sheet.level).toBe(4);
  });

  it('renames the character and keeps sheet.name in sync', async () => {
    const userId = await seedUser();
    const uc = createUserCharacter(userId, { name: 'Bob' });
    const updated = updateUserCharacter(uc.id, userId, { name: 'Robert' });
    expect(updated?.name).toBe('Robert');
    expect(updated?.sheet.name).toBe('Robert');
  });

  it('refuses to update a character owned by someone else', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const uc = createUserCharacter(alice, { name: 'AlicePC' });
    const res = updateUserCharacter(uc.id, bob, { name: 'Hacked' });
    expect(res).toBeNull();
    expect(getUserCharacter(uc.id, alice)?.name).toBe('AlicePC');
  });
});

describe('deleteUserCharacter', () => {
  it('removes the row', async () => {
    const userId = await seedUser();
    const uc = createUserCharacter(userId, { name: 'Bob' });
    expect(deleteUserCharacter(uc.id, userId)).toBe(true);
    expect(getUserCharacter(uc.id, userId)).toBeNull();
  });

  it('returns false when the character does not belong to the caller', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const uc = createUserCharacter(alice, { name: 'AlicePC' });
    expect(deleteUserCharacter(uc.id, bob)).toBe(false);
    expect(getUserCharacter(uc.id, alice)).not.toBeNull();
  });
});
