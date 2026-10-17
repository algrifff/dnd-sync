import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from './db';
import { writeNote } from './import-apply';
import { setupTestDb, teardownTestDb } from './test-utils';
import { createUser, DEFAULT_GROUP_ID } from './users';

let userId: string;

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({
    username: 'importer',
    displayName: 'Importer',
    password: 'correct-horse-battery',
    role: 'admin',
  });
  userId = user.id;
});
afterAll(() => teardownTestDb());
afterEach(() => getDb().exec('DROP TRIGGER IF EXISTS fail_tags'));

function write(path: string, markdown: string, opts: { isUpdate?: boolean; noteId?: string } = {}) {
  writeNote({
    groupId: DEFAULT_GROUP_ID,
    userId,
    path,
    markdown,
    frontmatter: { tags: ['npc'] },
    isUpdate: opts.isUpdate ?? false,
    noteId: opts.noteId,
  });
}

function counts(path: string) {
  const db = getDb();
  const n = (sql: string) => db.query<{ n: number }, [string, string]>(sql).get(DEFAULT_GROUP_ID, path)!.n;
  return {
    notes: n('SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?'),
    links: n('SELECT COUNT(*) AS n FROM note_links WHERE group_id = ? AND from_path = ?'),
    tags: n('SELECT COUNT(*) AS n FROM tags WHERE group_id = ? AND path = ?'),
  };
}

function failOnTagInsert(): void {
  getDb().exec(`
    CREATE TRIGGER fail_tags BEFORE INSERT ON tags
    BEGIN SELECT RAISE(ABORT, 'tag insert failed'); END;
  `);
}

describe('writeNote', () => {
  it('writes the note, its links and its tags', () => {
    write('World Lore/Ok.md', 'Meets [[World Lore/Friend]].');

    expect(counts('World Lore/Ok.md')).toEqual({ notes: 1, links: 1, tags: 1 });
  });

  it('should leave no note or links behind when a later write fails on insert', () => {
    failOnTagInsert();

    expect(() => write('World Lore/Fresh.md', 'Meets [[World Lore/Friend]].')).toThrow();

    expect(counts('World Lore/Fresh.md')).toEqual({ notes: 0, links: 0, tags: 0 });
  });

  it('should keep the previous note, links and tags when an update fails part-way', () => {
    write('World Lore/Edited.md', 'Meets [[World Lore/Friend]].');
    const before = getDb()
      .query<{ id: string; content_md: string }, [string, string]>(
        'SELECT id, content_md FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(DEFAULT_GROUP_ID, 'World Lore/Edited.md')!;
    failOnTagInsert();

    expect(() =>
      write('World Lore/Edited.md', 'Now meets [[World Lore/Rival]].', {
        isUpdate: true,
        noteId: before.id,
      }),
    ).toThrow();

    const after = getDb()
      .query<{ content_md: string }, [string, string]>(
        'SELECT content_md FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(DEFAULT_GROUP_ID, 'World Lore/Edited.md')!;
    expect(after.content_md).toBe(before.content_md);
    expect(counts('World Lore/Edited.md')).toEqual({ notes: 1, links: 1, tags: 1 });
    const link = getDb()
      .query<{ to_path: string }, [string, string]>(
        'SELECT to_path FROM note_links WHERE group_id = ? AND from_path = ?',
      )
      .get(DEFAULT_GROUP_ID, 'World Lore/Edited.md');
    expect(link?.to_path).toContain('Friend');
  });

  it('should work when called from inside a caller-owned transaction', () => {
    const db = getDb();

    db.transaction(() => {
      write('World Lore/Nested.md', 'Meets [[World Lore/Friend]].');
    })();

    expect(counts('World Lore/Nested.md')).toEqual({ notes: 1, links: 1, tags: 1 });
  });
});
