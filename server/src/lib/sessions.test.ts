import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { deriveAllIndexes } from './derive-indexes';
import { visibilityFor } from './notes';
import { nextSessionNumber } from './sessions';
import { setupTestDb, teardownTestDb } from './test-utils';
import { DEFAULT_GROUP_ID } from './users';

const FOLDER = 'Campaigns/Ashfall';

function seedSession(
  path: string,
  fm: Record<string, unknown>,
  hidden: { dmOnly?: boolean; gmOnly?: boolean } = {},
): void {
  const json = JSON.stringify({ kind: 'session', ...fm });
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, ?, 0, ?, NULL, ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), DEFAULT_GROUP_ID, path, path, json, now, now, hidden.dmOnly ? 1 : 0, hidden.gmOnly ? 1 : 0);
  deriveAllIndexes({ groupId: DEFAULT_GROUP_ID, notePath: path, frontmatterJson: json });
}

function next(role: 'admin' | 'editor' | 'viewer'): number {
  return nextSessionNumber({
    groupId: DEFAULT_GROUP_ID,
    campaignSlug: 'ashfall',
    folderPath: FOLDER,
    vis: visibilityFor(role),
  });
}

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => {
  getDb().query('DELETE FROM notes WHERE group_id = ?').run(DEFAULT_GROUP_ID);
  getDb().query('DELETE FROM session_notes WHERE group_id = ?').run(DEFAULT_GROUP_ID);
});

describe('nextSessionNumber', () => {
  it('should start at 1 in an empty campaign', () => {
    expect(next('admin')).toBe(1);
  });

  it('should go one past the highest Session #', () => {
    seedSession(`${FOLDER}/Adventure Log/a.md`, { campaigns: ['ashfall'], sheet: { session_number: 7 } });

    expect(next('admin')).toBe(8);
  });

  it('should count unnumbered Sessions as a floor', () => {
    seedSession(`${FOLDER}/Adventure Log/a.md`, { campaigns: ['ashfall'], sheet: {} });
    seedSession(`${FOLDER}/Adventure Log/b.md`, { campaigns: ['ashfall'], sheet: {} });

    expect(next('admin')).toBe(3);
  });

  it('should count a Session filed under the campaign folder by display name', () => {
    seedSession(`${FOLDER}/Adventure Log/a.md`, { campaigns: ['Ashfall Campaign'], sheet: { session_number: 4 } });

    expect(next('admin')).toBe(5);
  });

  it("should ignore other campaigns' Sessions", () => {
    seedSession('Campaigns/Brindle/Adventure Log/a.md', { campaigns: ['brindle'], sheet: { session_number: 9 } });

    expect(next('admin')).toBe(1);
  });

  it('should leave out Sessions the caller cannot see', () => {
    seedSession(`${FOLDER}/Adventure Log/open.md`, { campaigns: ['ashfall'], sheet: { session_number: 1 } });
    seedSession(`${FOLDER}/Adventure Log/secret.md`, { campaigns: ['ashfall'], sheet: { session_number: 2 } }, { dmOnly: true });
    seedSession(`${FOLDER}/Adventure Log/private.md`, { campaigns: ['ashfall'], sheet: { session_number: 3 } }, { gmOnly: true });

    expect([next('viewer'), next('editor'), next('admin')]).toEqual([2, 3, 4]);
  });
});
