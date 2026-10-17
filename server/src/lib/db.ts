// SQLite singleton. Opens compendium.db under $DATA_DIR, applies pending
// migrations, and returns a ready handle.
//
// Backing store is bun:sqlite everywhere: dev, tests and production all
// run under Bun. The adapter below wraps it in the small Database
// interface (query/get/all/run) that every call site uses.

import type { Database as BunDatabase, SQLQueryBindings } from 'bun:sqlite';
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

// ── bun:sqlite adapter ─────────────────────────────────────────────────

function makeBunDatabase(path: string): Database {
  // Loaded lazily through createRequire, not a top-level import: `next build`
  // collects page data in Node worker processes, where a static
  // `import 'bun:sqlite'` fails to resolve ("Cannot find module") even
  // though nothing opens the DB there. At runtime this is always Bun.
  const { Database: BunDB } = createRequire(import.meta.url)('bun:sqlite') as { Database: new (path: string) => BunDatabase };
  const inner = new BunDB(path);

  // bun:sqlite Statement.run() returns void; follow up with changes() to
  // build the RunResult shape that the codebase relies on.
  const changesStmt = inner.query<{ c: number; r: number }, []>(
    'SELECT changes() AS c, last_insert_rowid() AS r',
  );

  return {
    exec: (sql) => { inner.exec(sql); },
    query: <Row = unknown, Params extends unknown[] = unknown[]>(sql: string): Statement<Row, Params> => {
      const stmt = inner.query<Row, SQLQueryBindings[]>(sql);
      return {
        get: (...params: Params): Row | undefined =>
          stmt.get(...(params as SQLQueryBindings[])) ?? undefined,
        all: (...params: Params): Row[] => stmt.all(...(params as SQLQueryBindings[])),
        run: (...params: Params): RunResult => {
          stmt.run(...(params as SQLQueryBindings[]));
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

// ── public API ──────────────────────────────────────────────────────────

export function getDb(): Database {
  if (db) return db;

  const path = join(resolveDataDir(), 'compendium.db');
  const handle = makeBunDatabase(path);

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

// ── constraint-violation detection ──────────────────────────────────────
//
// bun:sqlite throws a `SQLiteError` whose `.code` is the extended SQLite
// result-code string, e.g. `SQLITE_CONSTRAINT_UNIQUE` /
// `SQLITE_CONSTRAINT_PRIMARYKEY`.
//
// Do NOT match on `.message` — it embeds the table/column name and
// wording isn't a contract. `.code` is the stable signal.
//
// Only the UNIQUE and PRIMARYKEY constraint codes are treated as "the
// row already exists" — a NOTNULL/FOREIGNKEY/CHECK violation is a real
// bug and should still surface as an unhandled 500.
export function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

