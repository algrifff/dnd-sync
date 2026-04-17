// Forward-only migration runner. Tracks the current schema version in
// schema_version and applies anything that hasn't run yet. Each migration
// is wrapped in a transaction.

import type { Database } from 'bun:sqlite';

type Migration = {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
};

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'initial schema: text_docs, binary_files, fts index',
    sql: `
      CREATE TABLE text_docs (
        path         TEXT    PRIMARY KEY,
        yjs_state    BLOB    NOT NULL,
        text_content TEXT    NOT NULL DEFAULT '',
        updated_at   INTEGER NOT NULL,
        updated_by   TEXT
      ) WITHOUT ROWID;

      CREATE TABLE binary_files (
        path       TEXT    PRIMARY KEY,
        data       BLOB    NOT NULL,
        mime_type  TEXT    NOT NULL,
        size       INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      ) WITHOUT ROWID;

      CREATE VIRTUAL TABLE text_docs_fts USING fts5(
        path UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );

      -- Keep FTS in sync with text_docs.text_content.
      CREATE TRIGGER text_docs_ai AFTER INSERT ON text_docs BEGIN
        INSERT INTO text_docs_fts(path, content) VALUES (new.path, new.text_content);
      END;

      CREATE TRIGGER text_docs_au AFTER UPDATE OF text_content ON text_docs BEGIN
        DELETE FROM text_docs_fts WHERE path = old.path;
        INSERT INTO text_docs_fts(path, content) VALUES (new.path, new.text_content);
      END;

      CREATE TRIGGER text_docs_ad AFTER DELETE ON text_docs BEGIN
        DELETE FROM text_docs_fts WHERE path = old.path;
      END;
    `,
  },
  {
    version: 2,
    description: 'config table for auto-generated tokens + installer key',
    sql: `
      CREATE TABLE config (
        key        TEXT    PRIMARY KEY,
        value      TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
    `,
  },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const row = db
    .query<{ max: number | null }, []>('SELECT MAX(version) AS max FROM schema_version')
    .get();
  const current = row?.max ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.query('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      );
    })();
    console.log(`[db] applied migration v${migration.version}: ${migration.description}`);
  }
}

/** Latest schema version the code knows about. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
