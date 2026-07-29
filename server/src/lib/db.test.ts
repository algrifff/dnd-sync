// isUniqueConstraintError() must recognise a real UNIQUE / PRIMARY KEY
// violation from the runtime's actual DB adapter (bun:sqlite under
// `bun test`; better-sqlite3 in production) so route handlers can
// translate a lost create-race into a clean 409 instead of a raw
// driver error reaching the client as an unhandled 500.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getDb, isUniqueConstraintError } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DROP TABLE IF EXISTS unique_probe');
  db.exec(`
    CREATE TABLE unique_probe (
      id   TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      UNIQUE (path)
    ) WITHOUT ROWID;
  `);
});

describe('isUniqueConstraintError', () => {
  it('recognises a UNIQUE(...) column violation', () => {
    const db = getDb();
    db.query('INSERT INTO unique_probe (id, path) VALUES (?, ?)').run('a', 'x');

    let caught: unknown;
    try {
      db.query('INSERT INTO unique_probe (id, path) VALUES (?, ?)').run('b', 'x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueConstraintError(caught)).toBe(true);
  });

  it('recognises a WITHOUT ROWID PRIMARY KEY violation', () => {
    const db = getDb();
    db.query('INSERT INTO unique_probe (id, path) VALUES (?, ?)').run('a', 'x');

    let caught: unknown;
    try {
      db.query('INSERT INTO unique_probe (id, path) VALUES (?, ?)').run('a', 'y');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueConstraintError(caught)).toBe(true);
  });

  it('does not flag an unrelated error as a constraint violation', () => {
    let caught: unknown;
    try {
      getDb().query('SELECT * FROM this_table_does_not_exist').get();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueConstraintError(caught)).toBe(false);
  });

  it('is false for non-error, non-object, and plain-object inputs', () => {
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
    expect(isUniqueConstraintError('boom')).toBe(false);
    expect(isUniqueConstraintError(new Error('generic'))).toBe(false);
    expect(isUniqueConstraintError({ code: 'SQLITE_CONSTRAINT_NOTNULL' })).toBe(false);
  });
});
