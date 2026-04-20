import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { decodePath, loadNote, loadTags } from './notes';
import { setupTestDb, teardownTestDb } from './test-utils';
import { DEFAULT_GROUP_ID } from './users';

// ── Test helpers ───────────────────────────────────────────────────────

function seedGroup(id: string, name = id): void {
  getDb()
    .query(
      `INSERT OR IGNORE INTO groups (id, name, created_at) VALUES (?, ?, ?)`,
    )
    .run(id, name, Date.now());
}

function seedNote(groupId: string, path: string): string {
  const id = randomUUID();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, content_json, updated_at)
       VALUES (?, ?, ?, '{}', ?)`,
    )
    .run(id, groupId, path, Date.now());
  return id;
}

function seedTag(groupId: string, path: string, tag: string): void {
  getDb()
    .query(`INSERT INTO tags (group_id, path, tag) VALUES (?, ?, ?)`)
    .run(groupId, path, tag);
}

function seedLink(groupId: string, fromPath: string, toPath: string): void {
  getDb()
    .query(`INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)`)
    .run(groupId, fromPath, toPath);
}

function seedAlias(groupId: string, path: string, alias: string): void {
  getDb()
    .query(`INSERT INTO aliases (group_id, path, alias) VALUES (?, ?, ?)`)
    .run(groupId, path, alias);
}

function countLinks(groupId: string, path: string): number {
  const row = getDb()
    .query<{ n: number }, [string, string, string]>(
      `SELECT COUNT(*) AS n FROM note_links
        WHERE group_id = ? AND (from_path = ? OR to_path = ?)`,
    )
    .get(groupId, path, path);
  return row?.n ?? 0;
}

function countAliases(groupId: string, path: string): number {
  const row = getDb()
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM aliases WHERE group_id = ? AND path = ?`,
    )
    .get(groupId, path);
  return row?.n ?? 0;
}

// ── DB setup ───────────────────────────────────────────────────────────

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM note_links');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM aliases');
  db.exec('DELETE FROM notes');
});

// ── decodePath ─────────────────────────────────────────────────────────

describe('decodePath', () => {
  it('joins segments with forward slashes', () => {
    expect(decodePath(['a', 'b', 'c.md'])).toBe('a/b/c.md');
  });

  it('handles a single segment', () => {
    expect(decodePath(['note.md'])).toBe('note.md');
  });

  it('decodes percent-encoded characters', () => {
    expect(decodePath(['my%20note.md'])).toBe('my note.md');
  });

  it('returns null for an empty array', () => {
    expect(decodePath([])).toBeNull();
  });

  it('returns null for a .. traversal segment', () => {
    expect(decodePath(['..'])).toBeNull();
    expect(decodePath(['a', '..', 'b'])).toBeNull();
  });

  it('returns null for a . current-dir segment', () => {
    expect(decodePath(['.', 'note.md'])).toBeNull();
  });

  it('returns null for a segment containing a null byte', () => {
    expect(decodePath(['note\x00.md'])).toBeNull();
  });

  it('returns null for a segment containing a backslash', () => {
    expect(decodePath(['a\\b.md'])).toBeNull();
  });

  it('returns null for a segment containing a colon (drive letter)', () => {
    expect(decodePath(['C:note.md'])).toBeNull();
  });

  it('returns null for malformed percent encoding', () => {
    expect(decodePath(['%ZZ'])).toBeNull();
  });
});

// ── loadNote / multi-tenancy ───────────────────────────────────────────

describe('loadNote — multi-tenancy', () => {
  const path = 'vault/secret.md';

  it('returns a note when queried with the correct group', () => {
    seedNote(DEFAULT_GROUP_ID, path);
    expect(loadNote(DEFAULT_GROUP_ID, path)).not.toBeNull();
  });

  it('returns null when a different group id is used', () => {
    const otherGroup = 'group-other-' + randomUUID().slice(0, 8);
    seedGroup(otherGroup);
    seedNote(DEFAULT_GROUP_ID, path);
    expect(loadNote(otherGroup, path)).toBeNull();
  });

  it('returns null for a path that does not exist', () => {
    expect(loadNote(DEFAULT_GROUP_ID, 'does-not-exist.md')).toBeNull();
  });
});

// ── cascade delete ─────────────────────────────────────────────────────

describe('cascade delete', () => {
  const target = 'notes/target.md';
  const other = 'notes/other.md';

  function performCascadeDelete(groupId: string, path: string): void {
    const db = getDb();
    db.transaction(() => {
      db.query(
        `DELETE FROM note_links WHERE group_id = ? AND (from_path = ? OR to_path = ?)`,
      ).run(groupId, path, path);
      db.query(`DELETE FROM tags WHERE group_id = ? AND path = ?`).run(groupId, path);
      db.query(`DELETE FROM aliases WHERE group_id = ? AND path = ?`).run(groupId, path);
      db.query(`DELETE FROM notes WHERE group_id = ? AND path = ?`).run(groupId, path);
    })();
  }

  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, target);
    seedNote(DEFAULT_GROUP_ID, other);
    seedTag(DEFAULT_GROUP_ID, target, 'adventure');
    seedTag(DEFAULT_GROUP_ID, target, 'lore');
    seedLink(DEFAULT_GROUP_ID, other, target); // incoming link to target
    seedLink(DEFAULT_GROUP_ID, target, other); // outgoing link from target
    seedAlias(DEFAULT_GROUP_ID, target, 'the-target');
  });

  it('removes the note row', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(loadNote(DEFAULT_GROUP_ID, target)).toBeNull();
  });

  it('removes all tags for the deleted note', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(loadTags(DEFAULT_GROUP_ID, target)).toHaveLength(0);
  });

  it('removes all note_links involving the deleted note (both directions)', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(countLinks(DEFAULT_GROUP_ID, target)).toBe(0);
  });

  it('removes all aliases for the deleted note', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(countAliases(DEFAULT_GROUP_ID, target)).toBe(0);
  });

  it('does not affect the other note', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(loadNote(DEFAULT_GROUP_ID, other)).not.toBeNull();
  });

  it('leaves tags on other notes intact', () => {
    seedTag(DEFAULT_GROUP_ID, other, 'unrelated');
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(loadTags(DEFAULT_GROUP_ID, other)).toEqual(['unrelated']);
  });
});
