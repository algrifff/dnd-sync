// Migration v48: notes_fts indexes path + group_id; the notes triggers
// keep it in sync through edits, moves and deletes without call sites
// touching notes_fts directly.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { worldFtsMatch } from './search';
import { setupTestDb, teardownTestDb } from './test-utils';

const A = randomUUID();
const B = randomUUID();

function insertNote(groupId: string, path: string, title: string, body: string): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(randomUUID(), groupId, path, title, body, Date.now());
}

function ftsRows(groupId: string): { path: string; title: string; content: string }[] {
  return getDb()
    .query<{ path: string; title: string; content: string }, [string]>(
      'SELECT path, title, content FROM notes_fts WHERE group_id = ? ORDER BY path',
    )
    .all(groupId);
}

function search(groupId: string, q: string): string[] {
  const match = worldFtsMatch(groupId, q);
  if (!match) return [];
  return getDb()
    .query<{ path: string }, [string, string]>(
      'SELECT path FROM notes_fts WHERE notes_fts MATCH ? AND group_id = ? ORDER BY path',
    )
    .all(match, groupId)
    .map((r) => r.path);
}

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM notes; DELETE FROM groups;');
  for (const id of [A, B]) {
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, id, Date.now());
  }
});

describe('notes_fts (v48)', () => {
  it('replaces the row when a note body changes', () => {
    insertNote(A, 'Lore/Moon.md', 'Moon', 'silver light');

    getDb().query(`UPDATE notes SET content_text = 'red eclipse' WHERE group_id = ? AND path = ?`).run(A, 'Lore/Moon.md');

    expect(ftsRows(A)).toEqual([{ path: 'Lore/Moon.md', title: 'Moon', content: 'red eclipse' }]);
  });

  it('follows a note to its new path when it moves', () => {
    insertNote(A, 'Inbox/Moon.md', 'Moon', 'silver light');

    getDb().query(`UPDATE notes SET path = 'Lore/Moon.md' WHERE group_id = ? AND path = ?`).run(A, 'Inbox/Moon.md');

    expect(ftsRows(A).map((r) => r.path)).toEqual(['Lore/Moon.md']);
    expect(search(A, 'silver')).toEqual(['Lore/Moon.md']);
  });

  it('drops the row when the note is deleted', () => {
    insertNote(A, 'Lore/Moon.md', 'Moon', '');

    getDb().query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(A, 'Lore/Moon.md');

    expect(ftsRows(A)).toEqual([]);
  });

  it('only touches the exact path, even when another path contains it', () => {
    insertNote(A, 'Lore/Moon.md', 'Moon', '');
    insertNote(A, 'Old/Lore/Moon.md', 'Old Moon', '');

    getDb().query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(A, 'Lore/Moon.md');

    expect(ftsRows(A).map((r) => r.path)).toEqual(['Old/Lore/Moon.md']);
  });

  it('handles paths containing double quotes', () => {
    insertNote(A, 'Lore/The "Moon".md', 'Moon', '');

    getDb().query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(A, 'Lore/The "Moon".md');

    expect(ftsRows(A)).toEqual([]);
  });

  it('leaves another world alone when a note with the same path changes', () => {
    insertNote(A, 'Lore/Moon.md', 'Moon', 'world a');
    insertNote(B, 'Lore/Moon.md', 'Moon', 'world b');

    getDb().query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(A, 'Lore/Moon.md');

    expect(ftsRows(B)).toEqual([{ path: 'Lore/Moon.md', title: 'Moon', content: 'world b' }]);
    expect(search(B, 'world')).toEqual(['Lore/Moon.md']);
  });

  it('scopes searches to one world', () => {
    insertNote(A, 'a.md', 'Dragon', '');
    insertNote(B, 'b.md', 'Dragon', '');

    expect(search(A, 'dragon')).toEqual(['a.md']);
  });

  it('never matches on folder names or the world id', () => {
    insertNote(A, 'Characters/Gandrel.md', 'Gandrel', 'a wizard');

    expect(search(A, 'characters')).toEqual([]);
    expect(search(A, A)).toEqual([]);
  });

  it('treats FTS5 syntax in the query as plain words', () => {
    insertNote(A, 'a.md', 'Half-Elf Ranger', '');

    expect(search(A, 'half-elf')).toEqual(['a.md']);
    expect(search(A, 'NEAR(" OR *')).toEqual([]);
  });
});
