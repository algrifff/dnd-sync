#!/usr/bin/env bun
// Apply a bundle.json (produced by export-bundle.ts) to a target SQLite.
// The target must be a Compendium DB whose migrations are at the same
// version as the source — run the server once first to migrate before
// applying.
//
// Safety: refuses to apply if the target already has a `groups` row with
// the same id. To re-apply, manually purge the group first.
//
// Usage (local against a copy of the prod volume):
//   DATA_DIR=/path/to/copy/of/prod/.data \
//     bun run scripts/main-notes-import/apply-bundle.ts \
//     --bundle bundle.json
//
// Usage (against prod via Railway shell):
//   railway run bun run scripts/main-notes-import/apply-bundle.ts \
//     --bundle /tmp/bundle.json
//
// Apply order respects FK dependencies:
//   users → groups → group_members → folder_markers → assets (rows)
//   → notes → note_links → tags → aliases → asset_tags → campaigns
//   → characters → character_campaigns → items → locations → creatures
//   → session_notes → ai_personalities
//
// Asset BLOBS are written to disk BEFORE the assets table inserts so
// the on-disk content-addressed file is in place when the row points
// at it.
//
// Triggers: notes_fts is auto-rebuilt on notes INSERT — nothing to do.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDb } from '../../server/src/lib/db';
import { assetPath } from '../../server/src/lib/assets';

type Bundle = {
  schemaVersion: number;
  groupId: string;
  userId: string;
  user: Record<string, unknown>;
  group: Record<string, unknown>;
  group_members: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  note_links: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  aliases: Array<Record<string, unknown>>;
  folder_markers: Array<Record<string, unknown>>;
  campaigns: Array<Record<string, unknown>>;
  characters: Array<Record<string, unknown>>;
  character_campaigns: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
  creatures: Array<Record<string, unknown>>;
  session_notes: Array<Record<string, unknown>>;
  asset_tags: Array<Record<string, unknown>>;
  ai_personalities: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  asset_files: Array<{ hash: string; mime: string; data: string }>;
};

type Args = { bundle: string };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const bundle = get('--bundle');
  if (!bundle) throw new Error('missing --bundle <path-to-bundle.json>');
  return { bundle };
}

function decodeBase64Field(
  row: Record<string, unknown>,
  field: string,
): void {
  const v = row[field];
  if (typeof v === 'string') row[field] = Buffer.from(v, 'base64');
  else if (v == null) row[field] = null;
}

function buildInsertSql(table: string, columns: string[]): string {
  const placeholders = columns.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
}

function insertRows(
  table: string,
  rows: Array<Record<string, unknown>>,
  /** Optional column-rewrite hook (e.g. base64 → Buffer). */
  fix?: (row: Record<string, unknown>) => void,
): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  // Take the column set from the first row — every row in the bundle
  // for a given table has the same columns (it's a SELECT * dump).
  const columns = Object.keys(rows[0]!);
  const sql = buildInsertSql(table, columns);
  const stmt = db.query(sql);
  let inserted = 0;
  for (const r of rows) {
    if (fix) fix(r);
    const params = columns.map((c) => r[c]);
    try {
      stmt.run(...params);
      inserted++;
    } catch (err) {
      console.error(`[apply] insert into ${table} failed:`, (err as Error).message);
      console.error('  row:', JSON.stringify(r).slice(0, 200));
      throw err;
    }
  }
  return inserted;
}

function main(): void {
  const { bundle: bundlePath } = parseArgs();
  const raw = readFileSync(resolve(bundlePath), 'utf8');
  const bundle = JSON.parse(raw) as Bundle;

  if (bundle.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion ${bundle.schemaVersion}`);
  }

  const db = getDb();

  // Refuse if the group already exists.
  const existing = db
    .query<{ id: string }, [string]>('SELECT id FROM groups WHERE id = ?')
    .get(bundle.groupId);
  if (existing) {
    throw new Error(
      `target DB already has a group with id ${bundle.groupId} — purge first or pick a fresh id`,
    );
  }

  // 1. Asset BLOBS to disk first (so notes can resolve their assetIds).
  let assetsWritten = 0;
  for (const f of bundle.asset_files) {
    const path = assetPath(f.hash, f.mime);
    if (!existsSync(path)) {
      writeFileSync(path, Buffer.from(f.data, 'base64'));
      assetsWritten++;
    }
  }

  // 2. Apply DB rows in FK order, all in one transaction so a partial
  // failure rolls back cleanly.
  db.exec('BEGIN');
  try {
    // users — skip if a user with the same id already exists. (This is
    // the common case on prod where algrifff's real account predates
    // the import.)
    const userRow = bundle.user as Record<string, unknown>;
    const userExists = db
      .query<{ id: string }, [string]>('SELECT id FROM users WHERE id = ?')
      .get(String(userRow.id));
    if (!userExists) {
      insertRows('users', [userRow], (r) => decodeBase64Field(r, 'avatar_blob'));
    } else {
      console.log(`[apply] users: id ${userRow.id} already exists, skipping`);
    }

    insertRows('groups', [bundle.group], (r) => decodeBase64Field(r, 'icon_blob'));
    insertRows('group_members', bundle.group_members);
    insertRows('folder_markers', bundle.folder_markers);
    insertRows('assets', bundle.assets);
    insertRows('notes', bundle.notes, (r) => decodeBase64Field(r, 'yjs_state'));
    insertRows('note_links', bundle.note_links);
    insertRows('tags', bundle.tags);
    insertRows('aliases', bundle.aliases);
    insertRows('asset_tags', bundle.asset_tags);
    insertRows('campaigns', bundle.campaigns);
    insertRows('characters', bundle.characters);
    insertRows('character_campaigns', bundle.character_campaigns);
    insertRows('items', bundle.items);
    insertRows('locations', bundle.locations);
    insertRows('creatures', bundle.creatures);
    insertRows('session_notes', bundle.session_notes);
    insertRows('ai_personalities', bundle.ai_personalities);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log('[apply] done.');
  console.log(`[apply]   asset blobs written: ${assetsWritten}`);
  console.log(`[apply]   notes:               ${bundle.notes.length}`);
  console.log(`[apply]   characters:          ${bundle.characters.length}`);
  console.log(`[apply]   campaigns:           ${bundle.campaigns.length}`);
  console.log(`[apply]   note_links:          ${bundle.note_links.length}`);
  console.log(`[apply] groupId now live:      ${bundle.groupId}`);
}

main();
