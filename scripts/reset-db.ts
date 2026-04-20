#!/usr/bin/env bun
// Wipes all campaign data from the database while preserving user accounts
// and HTTP sessions. Run from the repo root: bun scripts/reset-db.ts
//
// Use in dev to get a clean slate when folder structure changes.

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';

const dataDir = process.env.DATA_DIR ?? './server/.data';
const dbPath = `${dataDir}/compendium.db`;

if (!existsSync(dbPath)) {
  console.log(`No database found at ${dbPath} — nothing to reset.`);
  process.exit(0);
}

const db = new Database(dbPath, { strict: true });

const tables = [
  'notes',
  'notes_fts',
  'note_links',
  'folder_markers',
  'characters',
  'character_campaigns',
  'session_notes',
  'import_jobs',
  'assets',
  'group_members',
  'groups',
  'group_invite_tokens',
  'audit_log',
  'note_templates',
] as const;

db.transaction(() => {
  for (const table of tables) {
    try {
      db.query(`DELETE FROM ${table}`).run();
      console.log(`  cleared ${table}`);
    } catch (e) {
      // Table may not exist in older schema versions — skip it
      console.log(`  skipped ${table} (${e instanceof Error ? e.message : e})`);
    }
  }
})();

console.log('\nDone. Users and sessions preserved. Restart the server to re-seed defaults.');
