// v47 perf migration: index notes.created_by + assets.uploaded_by (the
// admin/users storage-stats query was a full table scan per user on
// both columns) and drop the redundant notes_group_path index (SQLite
// already backs UNIQUE (group_id, path) with an identical implicit
// index — see migrations.ts v7/v47 comments).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from './db';
import { LATEST_SCHEMA_VERSION } from './migrations';
import { setupTestDb, teardownTestDb } from './test-utils';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

function indexNames(table: string): string[] {
  return getDb()
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
    )
    .all(table)
    .map((r) => r.name);
}

describe('migration v47 — storage-stats indexes + redundant index cleanup', () => {
  it('has run by the time setupTestDb finishes migrating a fresh DB', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(47);
    const row = getDb()
      .query<{ max: number | null }, []>('SELECT MAX(version) AS max FROM schema_version')
      .get();
    expect(row?.max ?? 0).toBeGreaterThanOrEqual(47);
  });

  it('creates an index on notes(created_by)', () => {
    expect(indexNames('notes')).toContain('notes_created_by');
  });

  it('creates an index on assets(uploaded_by)', () => {
    expect(indexNames('assets')).toContain('assets_uploaded_by');
  });

  it('drops the redundant notes_group_path index', () => {
    expect(indexNames('notes')).not.toContain('notes_group_path');
  });

  it('leaves the UNIQUE (group_id, path) constraint on notes intact', () => {
    // The UNIQUE constraint from v7 backs its own implicit index (named
    // sqlite_autoindex_notes_N) — dropping notes_group_path must not
    // have touched it. Verify the constraint is still enforced.
    const db = getDb();
    const now = Date.now();
    db.query(
      `INSERT INTO notes (id, group_id, path, content_json, content_text, updated_at)
       VALUES ('n1', 'default', 'vault/dup.md', '{}', '', ?)`,
    ).run(now);

    let caught: unknown;
    try {
      db.query(
        `INSERT INTO notes (id, group_id, path, content_json, content_text, updated_at)
         VALUES ('n2', 'default', 'vault/dup.md', '{}', '', ?)`,
      ).run(now);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    db.query('DELETE FROM notes WHERE id IN (?, ?)').run('n1', 'n2');
  });
});
