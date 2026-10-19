import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { listGroupAssets } from './assets';
import { getDb } from './db';
import { visibilityFor } from './notes';
import { setupTestDb, teardownTestDb } from './test-utils';
import { DEFAULT_GROUP_ID } from './users';

function seedAsset(name: string, gmOnly: boolean): void {
  getDb()
    .query(
      `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_at, gm_only)
       VALUES (?, ?, ?, 'image/png', 1, ?, ?, ?)`,
    )
    .run(randomUUID(), DEFAULT_GROUP_ID, randomUUID(), name, Date.now(), gmOnly ? 1 : 0);
}

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  getDb().exec('DELETE FROM assets');
  seedAsset('shared.png', false);
  seedAsset('private.png', true);
});

describe('listGroupAssets', () => {
  const names = (role: 'admin' | 'editor' | 'viewer', mode: 'player' | 'gm') =>
    listGroupAssets(DEFAULT_GROUP_ID, { mode, vis: visibilityFor(role) }).map((a) => a.originalName);

  it('lists the player namespace to every role', () => {
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      expect(names(role, 'player')).toEqual(['shared.png']);
    }
  });

  it('lists the GM namespace to an admin in GM mode', () => {
    expect(names('admin', 'gm')).toEqual(['private.png']);
  });

  it('never lists a Private asset to a non-admin, even in GM mode', () => {
    expect(names('editor', 'gm')).toEqual([]);
    expect(names('viewer', 'gm')).toEqual([]);
  });
});
