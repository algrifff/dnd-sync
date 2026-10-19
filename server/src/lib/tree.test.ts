import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { buildTree, type TreeDir } from './tree';
import { DEFAULT_GROUP_ID } from './users';

let clock = 1;

function seedNote(path: string, title: string): void {
  const now = clock++;
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, '{}', 0, ?, NULL, ?, NULL)`,
    )
    .run(randomUUID(), DEFAULT_GROUP_ID, path, title, now, now);
}

function retitle(path: string, title: string): void {
  getDb()
    .query('UPDATE notes SET title = ?, updated_at = ? WHERE group_id = ? AND path = ?')
    .run(title, clock++, DEFAULT_GROUP_ID, path);
}

function labelsIn(folder: string): string[] {
  let dir: TreeDir = buildTree(DEFAULT_GROUP_ID, { hideDmOnly: false }).root;
  for (const segment of folder.split('/')) {
    const next = dir.children.find(
      (c): c is TreeDir => c.kind === 'dir' && c.name === segment,
    );
    if (!next) throw new Error(`no folder ${folder}`);
    dir = next;
  }
  return dir.children.map((c) => (c.kind === 'file' ? c.title || c.name : `${c.name}/`));
}

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => {
  getDb().query('DELETE FROM notes WHERE group_id = ?').run(DEFAULT_GROUP_ID);
});

describe('buildTree ordering', () => {
  it('should order files by title rather than filename', () => {
    seedNote('Lore/a.md', 'Zephyr');
    seedNote('Lore/b.md', 'Amber');

    expect(labelsIn('Lore')).toEqual(['Amber', 'Zephyr']);
  });

  it('should move a note when its title changes and its path does not', () => {
    seedNote('Lore/untitled.md', 'Untitled');
    seedNote('Lore/dragon.md', 'Dragon');
    expect(labelsIn('Lore')).toEqual(['Dragon', 'Untitled']);

    retitle('Lore/untitled.md', 'Aboleth');

    expect(labelsIn('Lore')).toEqual(['Aboleth', 'Dragon']);
  });

  it('should order numbered sessions numerically', () => {
    seedNote('Log/2026-01-01.md', 'Session 10_Alex_2026-03-01');
    seedNote('Log/2026-01-02.md', 'Session 9_Alex_2026-02-20');
    seedNote('Log/2026-01-03.md', 'Session 1_Sam_2026-01-01');

    expect(labelsIn('Log')).toEqual([
      'Session 1_Sam_2026-01-01',
      'Session 9_Alex_2026-02-20',
      'Session 10_Alex_2026-03-01',
    ]);
  });

  it('should keep folders ahead of files', () => {
    seedNote('Lore/Aardvark.md', 'Aardvark');
    seedNote('Lore/Zoo/Keeper.md', 'Keeper');

    expect(labelsIn('Lore')).toEqual(['Zoo/', 'Aardvark']);
  });
});
