// Test-only helpers. Spin up a fresh SQLite DB in a temp directory per
// test file so runs don't collide with each other or the dev volume.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from './db';

let testDir: string | null = null;

export function setupTestDb(): string {
  testDir = mkdtempSync(join(tmpdir(), 'compendium-test-'));
  process.env.DATA_DIR = testDir;
  closeDb();
  getDb(); // runs migrations on the fresh file
  return testDir;
}

export function teardownTestDb(): void {
  if (!testDir) return;
  closeDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* OS may still hold the WAL; best-effort */
  }
  testDir = null;
}

/** Make the next INSERT of a note at `path` lose a creation race. Installs
 *  a trigger that slips a competing row onto `path` just before the write
 *  lands, so the route's own COUNT pre-check passes and the
 *  UNIQUE(group_id, path) constraint is what rejects it. The racer is rolled
 *  back with the failed statement, so assert on the response, not the row.
 *  To simulate a racer that stays committed (e.g. a rename), spy on a call
 *  the route makes between its pre-check and its write instead. */
export function simulateNoteRace(path: string): void {
  const quoted = path.replace(/'/g, "''");
  getDb().exec(`
    DROP TRIGGER IF EXISTS note_race;
    CREATE TRIGGER note_race BEFORE INSERT ON notes
    WHEN NEW.path = '${quoted}'
    BEGIN
      INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                         content_md, yjs_state, frontmatter_json, byte_size,
                         updated_at, updated_by, created_at, created_by)
      VALUES ('racer-' || lower(hex(randomblob(8))), NEW.group_id, NEW.path, 'racer',
              '{}', '', '', NULL, '{}', 0, 0, NEW.updated_by, 0, NEW.created_by);
    END;
  `);
}

/** Remove the trigger `simulateNoteRace` installed. */
export function clearNoteRace(): void {
  getDb().exec('DROP TRIGGER IF EXISTS note_race');
}
