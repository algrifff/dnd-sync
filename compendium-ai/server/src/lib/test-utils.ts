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
