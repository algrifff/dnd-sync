// SQLite singleton. Opens compendium.db under $DATA_DIR, applies pending
// migrations, and returns a ready handle.
//
// Backing store is runtime-adaptive:
//   - bun:sqlite      when running under Bun  (tests, local dev)
//   - better-sqlite3  when running under Node.js  (production via Dockerfile)
//
// better-sqlite3 uses V8 API (not N-API) so its .node binary is Node
// version-specific. The Dockerfile's build stage rebuilds it against
// Node 22 after copying node_modules from the Bun install stage.
//
// Both back-ends expose the same Database interface (query/get/all/run)
// so every call site works unchanged regardless of which runtime is in use.

import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const IS_BUN = typeof process.versions.bun === 'string';

// ── bun:sqlite adapter ─────────────────────────────────────────────────

function makeBunDatabase(path: string): Database {
  // createRequire resolves bun:* built-in modules under Bun even in ESM.
  const _req = createRequire(import.meta.url);
  const { Database: BunDB } = _req('bun:sqlite') as { Database: new (p: string) => BunSqliteInner };
  const inner = new BunDB(path);

  // bun:sqlite Statement.run() returns void; follow up with changes() to
  // emulate better-sqlite3's RunResult shape that the codebase relies on.
  const changesStmt = inner.query<{ c: number; r: number }>(
    'SELECT changes() AS c, last_insert_rowid() AS r',
  );

  return {
    exec: (sql) => { inner.exec(sql); },
    query: <Row = unknown, Params extends unknown[] = unknown[]>(sql: string): Statement<Row, Params> => {
      const stmt = inner.query<Row>(sql);
      return {
        get: (...params: Params): Row | undefined =>
          stmt.get(...(params as unknown[])) ?? undefined,
        all: (...params: Params): Row[] => stmt.all(...(params as unknown[])),
        run: (...params: Params): RunResult => {
          stmt.run(...(params as unknown[]));
          const meta = changesStmt.get();
          return { changes: meta?.c ?? 0, lastInsertRowid: meta?.r ?? 0 };
        },
      };
    },
    transaction: <A extends unknown[]>(fn: (...args: A) => void) => {
      const wrapped = inner.transaction(fn);
      return (...args: A): void => { wrapped(...args); };
    },
    close: () => { inner.close(); },
  };
}

// Minimal shape of bun:sqlite Database that we actually use.
type BunSqliteInner = {
  exec(sql: string): void;
  query<Row>(sql: string): BunStmt<Row>;
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
};
type BunStmt<Row> = {
  get(...params: unknown[]): Row | null | undefined;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): void;
};

// ── better-sqlite3 adapter (Node.js runtime) ───────────────────────────

function makeNodeDatabase(path: string): Database {
  const inner = new BetterSqlite3(path);

  return {
    exec: (sql) => { inner.exec(sql); },
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
      return (...args: A): void => { wrapped(...args); };
    },
    close: () => { inner.close(); },
  };
}

// ── public API ──────────────────────────────────────────────────────────

function makeDatabase(path: string): Database {
  return IS_BUN ? makeBunDatabase(path) : makeNodeDatabase(path);
}

export function getDb(): Database {
  if (db) return db;

  const path = join(resolveDataDir(), 'compendium.db');
  const handle = makeDatabase(path);

  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA synchronous = NORMAL');
  // Retry writes for up to 5 s instead of failing immediately when
  // the Hocuspocus writer holds the WAL lock.
  handle.exec('PRAGMA busy_timeout = 5000');
  // Keep sorting / temp tables in RAM — SQLite otherwise spills to
  // disk files in the data dir even for modest intermediate sets.
  // Home-page COUNT and FTS MATCH queries both benefit.
  handle.exec('PRAGMA temp_store = MEMORY');
  // Memory-map ~64 MB of the DB so hot reads (tree, graph, notes
  // list) hit pages without round-tripping through the page cache.
  // The OS reclaims automatically; safe on all our deploy targets.
  handle.exec('PRAGMA mmap_size = 67108864');
  // Cap the page cache at ~32 MB (-32000 = KiB). Default is 2 MB
  // which is too small for the tree/graph builders.
  handle.exec('PRAGMA cache_size = -32000');

  runMigrations(handle);

  // One-shot optimiser: rebuilds index statistics based on current
  // row counts so the query planner picks the right indexes after
  // large imports. Cheap on startup, skipped silently if unsupported.
  try {
    handle.exec('PRAGMA optimize');
  } catch {
    /* older SQLite builds */
  }

  db = handle;
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

