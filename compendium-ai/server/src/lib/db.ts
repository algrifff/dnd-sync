// SQLite singleton. Opens compendium.db under $DATA_DIR, applies pending
// migrations, and returns a ready handle.
//
// Backing store is better-sqlite3 (Node-native, synchronous). The rest
// of the codebase was written against bun:sqlite's `db.query(sql)` API
// with generics in `<Row, Params>` order; we wrap better-sqlite3's
// `prepare(sql)` behind a `query` method with the same shape so every
// existing call site (128+ across the codebase) keeps working
// unchanged.

import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runMigrations } from './migrations';

export type RunResult = {
  changes: number;
  lastInsertRowid: number;
};

export type Statement<Row, Params extends unknown[]> = {
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
  run(...params: Params): RunResult;
};

export type Database = {
  exec(sql: string): void;
  query<Row = unknown, Params extends unknown[] = unknown[]>(
    sql: string,
  ): Statement<Row, Params>;
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
};

let db: Database | null = null;

function resolveDataDir(): string {
  const raw = process.env.DATA_DIR ?? './.data';
  const abs = resolve(raw);
  mkdirSync(abs, { recursive: true });
  return abs;
}

function makeDatabase(path: string): Database {
  const inner = new BetterSqlite3(path);

  return {
    exec: (sql) => {
      inner.exec(sql);
    },
    query: <Row = unknown, Params extends unknown[] = unknown[]>(sql: string): Statement<Row, Params> => {
      const stmt = inner.prepare(sql);
      return {
        get: (...params: Params): Row | undefined =>
          stmt.get(...(params as unknown[])) as Row | undefined,
        all: (...params: Params): Row[] =>
          stmt.all(...(params as unknown[])) as Row[],
        run: (...params: Params): RunResult => {
          const r = stmt.run(...(params as unknown[]));
          return {
            changes: Number(r.changes),
            lastInsertRowid: Number(r.lastInsertRowid),
          };
        },
      };
    },
    transaction: <A extends unknown[]>(fn: (...args: A) => void) => {
      const wrapped = inner.transaction(fn);
      return (...args: A): void => {
        wrapped(...args);
      };
    },
    close: () => {
      inner.close();
    },
  };
}

export function getDb(): Database {
  if (db) return db;

  const path = join(resolveDataDir(), 'compendium.db');
  const handle = makeDatabase(path);

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
