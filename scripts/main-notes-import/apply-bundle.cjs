#!/usr/bin/env node
// Standalone CommonJS version of apply-bundle.ts. Designed to run inside
// the Railway production container under plain `node`, with no TS / path
// alias / repo-relative imports — so it stays runnable when the rest of
// the build is broken or the working directory isn't /app/server.
//
// Mirror of apply-bundle.ts. If the TS version is changed, mirror the
// change here.
//
// Usage (inside the Railway shell after `railway ssh`):
//   cd /app
//   node scripts/main-notes-import/apply-bundle.cjs --bundle /data/bundle.json --data-dir /data

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const EXTENSION_FOR_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'application/octet-stream': 'bin',
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const bundle = get('--bundle');
  const dataDir = get('--data-dir') ?? process.env.DATA_DIR ?? '/data';
  if (!bundle) {
    console.error('missing --bundle <path>');
    process.exit(1);
  }
  return { bundle, dataDir };
}

function assetPath(dataDir, hash, mime) {
  const ext = EXTENSION_FOR_MIME[mime] ?? 'bin';
  const dir = path.join(path.resolve(dataDir), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${hash}.${ext}`);
}

function decodeBase64Field(row, field) {
  const v = row[field];
  if (typeof v === 'string') row[field] = Buffer.from(v, 'base64');
  else if (v == null) row[field] = null;
}

function insertRows(db, table, rows, fix) {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
  );
  let inserted = 0;
  for (const r of rows) {
    if (fix) fix(r);
    const params = columns.map((c) => r[c]);
    try {
      stmt.run(...params);
      inserted++;
    } catch (err) {
      console.error(`[apply] insert into ${table} failed:`, err.message);
      console.error('  row:', JSON.stringify(r).slice(0, 200));
      throw err;
    }
  }
  return inserted;
}

function main() {
  const { bundle: bundlePath, dataDir } = parseArgs();
  const dbPath = path.join(path.resolve(dataDir), 'compendium.db');
  console.log(`[apply] reading bundle: ${bundlePath}`);
  console.log(`[apply] target DB:      ${dbPath}`);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  if (bundle.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion ${bundle.schemaVersion}`);
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const existing = db
    .prepare('SELECT id FROM groups WHERE id = ?')
    .get(bundle.groupId);
  if (existing) {
    throw new Error(
      `target DB already has a group with id ${bundle.groupId} — purge first or pick a fresh id`,
    );
  }

  // Asset blobs to disk first so notes can reference them.
  let assetsWritten = 0;
  for (const f of bundle.asset_files) {
    const p = assetPath(dataDir, f.hash, f.mime);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
      assetsWritten++;
    }
  }

  const tx = db.transaction(() => {
    const userRow = bundle.user;
    const userExists = db
      .prepare('SELECT id FROM users WHERE id = ?')
      .get(String(userRow.id));
    if (!userExists) {
      insertRows(db, 'users', [userRow], (r) => decodeBase64Field(r, 'avatar_blob'));
      console.log(`[apply] users: inserted ${userRow.id}`);
    } else {
      console.log(`[apply] users: id ${userRow.id} already exists, skipping`);
    }

    insertRows(db, 'groups', [bundle.group], (r) => decodeBase64Field(r, 'icon_blob'));
    insertRows(db, 'group_members', bundle.group_members);
    insertRows(db, 'folder_markers', bundle.folder_markers);
    insertRows(db, 'assets', bundle.assets);
    insertRows(db, 'notes', bundle.notes, (r) => decodeBase64Field(r, 'yjs_state'));
    insertRows(db, 'note_links', bundle.note_links);
    insertRows(db, 'tags', bundle.tags);
    insertRows(db, 'aliases', bundle.aliases);
    insertRows(db, 'asset_tags', bundle.asset_tags);
    insertRows(db, 'campaigns', bundle.campaigns);
    insertRows(db, 'characters', bundle.characters);
    insertRows(db, 'character_campaigns', bundle.character_campaigns);
    insertRows(db, 'items', bundle.items);
    insertRows(db, 'locations', bundle.locations);
    insertRows(db, 'creatures', bundle.creatures);
    insertRows(db, 'session_notes', bundle.session_notes);
    insertRows(db, 'ai_personalities', bundle.ai_personalities);
  });
  tx();

  console.log('[apply] done.');
  console.log(`[apply]   asset blobs written: ${assetsWritten}`);
  console.log(`[apply]   notes:               ${bundle.notes.length}`);
  console.log(`[apply]   characters:          ${bundle.characters.length}`);
  console.log(`[apply]   campaigns:           ${bundle.campaigns.length}`);
  console.log(`[apply]   note_links:          ${bundle.note_links.length}`);
  console.log(`[apply] groupId now live:      ${bundle.groupId}`);
}

main();
