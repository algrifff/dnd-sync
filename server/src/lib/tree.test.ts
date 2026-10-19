import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { deriveAllIndexes } from './derive-indexes';
import { setupTestDb, teardownTestDb } from './test-utils';
import { buildTree, type TreeDir } from './tree';
import { DEFAULT_GROUP_ID } from './users';

let clock = 1;

function seedNote(path: string, title: string, frontmatter: Record<string, unknown> = {}): void {
  const now = clock++;
  const fm = JSON.stringify(frontmatter);
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, ?, 0, ?, NULL, ?, NULL)`,
    )
    .run(randomUUID(), DEFAULT_GROUP_ID, path, title, fm, now, now);
  deriveAllIndexes({ groupId: DEFAULT_GROUP_ID, notePath: path, frontmatterJson: fm });
}

function seedSession(path: string, title: string, sheet: Record<string, unknown>): void {
  seedNote(path, title, { kind: 'session', campaigns: ['ashfall'], sheet });
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
  getDb().query('DELETE FROM session_notes WHERE group_id = ?').run(DEFAULT_GROUP_ID);
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

  it('should compare numbers in titles numerically', () => {
    seedNote('Lore/a.md', 'Chapter 10');
    seedNote('Lore/b.md', 'Chapter 9');
    seedNote('Lore/c.md', 'Chapter 1');

    expect(labelsIn('Lore')).toEqual(['Chapter 1', 'Chapter 9', 'Chapter 10']);
  });

  it('should keep folders ahead of files', () => {
    seedNote('Lore/Aardvark.md', 'Aardvark');
    seedNote('Lore/Zoo/Keeper.md', 'Keeper');

    expect(labelsIn('Lore')).toEqual(['Zoo/', 'Aardvark']);
  });

});

describe('buildTree session ordering', () => {
  it('should keep sessions in date order whatever their titles', () => {
    seedSession('Log/2026-03-01.md', 'Alex — 2026-03-01', { date: '2026-03-01' });
    seedSession('Log/2026-01-01.md', 'Sam — 2026-01-01', { date: '2026-01-01' });
    seedSession('Log/2026-02-01-the-mill.md', 'The Mill', { date: '2026-02-01' });

    expect(labelsIn('Log')).toEqual(['Sam — 2026-01-01', 'The Mill', 'Alex — 2026-03-01']);
  });

  it('should order same-day sessions by session number', () => {
    seedSession('Log/b.md', 'Session 10_Alex_2026-03-01', { date: '2026-03-01', session_number: 10 });
    seedSession('Log/a.md', 'Session 9_Alex_2026-03-01', { date: '2026-03-01', session_number: 9 });

    expect(labelsIn('Log')).toEqual(['Session 9_Alex_2026-03-01', 'Session 10_Alex_2026-03-01']);
  });

  it('should place a new numbered session after undated imported ones', () => {
    seedSession('Log/session-2.md', 'Session 2', {});
    seedSession('Log/session-1.md', 'Session 1', {});
    seedSession('Log/2026-10-19.md', 'Session 3_Alice_2026-10-19', { date: '2026-10-19', session_number: 3 });

    expect(labelsIn('Log')).toEqual(['Session 1', 'Session 2', 'Session 3_Alice_2026-10-19']);
  });

  it('should order mixed dated and numbered sessions the same whatever the input order', () => {
    // Numbered by "date if both, else number" pairwise, these three form
    // a cycle and the result depends on the input order.
    const rows: Array<[string, Record<string, unknown>]> = [
      ['A', { date: '2026-01-01', session_number: 9 }],
      ['B', { session_number: 5 }],
      ['C', { date: '2026-02-01', session_number: 1 }],
    ];
    // Rows are read in path order, so the numeric prefix sets the order
    // the comparator sees them in.
    rows.forEach(([t, sheet], i) => seedSession(`Log/${i}-${t}.md`, t, sheet));
    const first = labelsIn('Log');
    getDb().query('DELETE FROM notes WHERE group_id = ?').run(DEFAULT_GROUP_ID);
    getDb().query('DELETE FROM session_notes WHERE group_id = ?').run(DEFAULT_GROUP_ID);

    [...rows].reverse().forEach(([t, sheet], i) => seedSession(`Log/${i}-${t}.md`, t, sheet));

    expect(first).toEqual(['C', 'B', 'A']);
    expect(labelsIn('Log')).toEqual(first);
  });

  it('should place sessions before other notes and undated sessions last among them', () => {
    seedNote('Log/recap.md', 'Aaa recap');
    seedSession('Log/undated.md', 'Undated', {});
    seedSession('Log/2026-01-01.md', 'Zed', { date: '2026-01-01' });

    expect(labelsIn('Log')).toEqual(['Zed', 'Undated', 'Aaa recap']);
  });
});
