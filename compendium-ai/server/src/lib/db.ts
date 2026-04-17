// SQLite singleton. Opens compendium.db under $DATA_DIR, applies pending
// migrations, and returns a ready handle.
//
// `bun:sqlite` is a Bun runtime built-in with no Node fallback. Next's
// `next build` phase runs route modules in Node workers to collect page
// data — if we imported bun:sqlite at module scope the build would fail
// with MODULE_NOT_FOUND. We take the type via `import type` (erased) and
// load the real value via eval('require') at first call, which webpack
// cannot statically trace. Under Bun the require resolves cleanly.

import type { Database as BunDatabase } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { runMigrations } from './migrations';

export type Database = BunDatabase;

type BunSqliteModule = { Database: typeof BunDatabase };

// `createRequire` works under Bun and lets us pull in `bun:sqlite` only when
// getDb() is first called (at runtime). The `bun:sqlite` literal is never
// imported at module scope, so Next's Node build worker doesn't try to
// resolve it during the page-data pass.
const nodeRequire = createRequire(import.meta.url);

let db: Database | null = null;

function loadBunSqlite(): BunSqliteModule {
  return nodeRequire('bun:sqlite') as BunSqliteModule;
}

function resolveDataDir(): string {
  const raw = process.env.DATA_DIR ?? './.data';
  const abs = resolve(raw);
  mkdirSync(abs, { recursive: true });
  return abs;
}

export function getDb(): Database {
  if (db) return db;

  const { Database } = loadBunSqlite();
  const path = join(resolveDataDir(), 'compendium.db');
  const handle = new Database(path, { create: true });

  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA synchronous = NORMAL');

  runMigrations(handle);

  db = handle;
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
