import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { visibilityFor } from '@/lib/notes';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { DEFAULT_GROUP_ID } from '@/lib/users';
import { hiddenReason } from './server';

function seedNote(path: string, flags: { dmOnly?: boolean; gmOnly?: boolean }): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, content_json, updated_at, dm_only, gm_only)
       VALUES (?, ?, ?, '{}', ?, ?, ?)`,
    )
    .run(randomUUID(), DEFAULT_GROUP_ID, path, Date.now(), flags.dmOnly ? 1 : 0, flags.gmOnly ? 1 : 0);
}

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  getDb().exec('DELETE FROM notes');
  seedNote('plain.md', {});
  seedNote('secret.md', { dmOnly: true });
  seedNote('private.md', { gmOnly: true });
  seedNote('both.md', { dmOnly: true, gmOnly: true });
});

describe('hiddenReason', () => {
  const reasons = (role: 'admin' | 'editor' | 'viewer') =>
    ['plain.md', 'secret.md', 'private.md', 'both.md', 'missing.md'].map((p) =>
      hiddenReason(DEFAULT_GROUP_ID, p, visibilityFor(role)),
    );

  it('refuses a viewer, reporting the Secret flag first on a note with both', () => {
    expect(reasons('viewer')).toEqual([null, 'dm_only_blocked', 'gm_only_blocked', 'dm_only_blocked', null]);
  });

  it('refuses an editor only the Private notes', () => {
    expect(reasons('editor')).toEqual([null, null, 'gm_only_blocked', 'gm_only_blocked', null]);
  });

  it('refuses an admin nothing', () => {
    expect(reasons('admin')).toEqual([null, null, null, null, null]);
  });
});
