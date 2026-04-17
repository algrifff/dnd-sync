// SQLite connection singleton. Opens compendium.db under $DATA_DIR,
// applies any pending migrations, and exposes a ready handle for the rest
// of the server. Uses bun:sqlite — zero native-addon install, Bun-native
// speed. If we ever move off Bun, swap this wrapper only (SQL stays).

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runMigrations } from './migrations';

let db: Database | null = null;

function resolveDataDir(): string {
  const raw = process.env.DATA_DIR ?? './.data';
  const abs = resolve(raw);
  mkdirSync(abs, { recursive: true });
  return abs;
}

/** Returns a ready SQLite handle, opening it on first call. */
export function getDb(): Database {
  if (db) return db;

  const path = join(resolveDataDir(), 'compendium.db');
  const handle = new Database(path, { create: true });

  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA synchronous = NORMAL');

  runMigrations(handle);

  db = handle;
  return db;
}

/** Close the connection. Tests / shutdown hooks. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export type { Database };
