import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { findUnlinkedMentions } from './unlinked-mentions';

const G = randomUUID();
const OTHER_WORLD = randomUUID();
const VOLO = 'People/Volo.md';

let clock = 1_000;

function note(path: string, title: string, body: string, opts: { dmOnly?: boolean; group?: string } = {}): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, updated_at, dm_only)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
    .run(randomUUID(), opts.group ?? G, path, title, body, clock++, opts.dmOnly ? 1 : 0);
}

const link = (from: string, to: string): void => {
  getDb()
    .query('INSERT INTO note_links (group_id, from_path, to_path, is_manual) VALUES (?, ?, ?, 1)')
    .run(G, from, to);
};

const find = (role: 'admin' | 'editor' | 'viewer' = 'editor', path = VOLO, limit?: number): string[] =>
  findUnlinkedMentions({ groupId: G, role, path, ...(limit ? { limit } : {}) }).map((m) => m.path);

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM notes; DELETE FROM aliases; DELETE FROM note_links; DELETE FROM groups;');
  for (const id of [G, OTHER_WORLD]) {
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, id, Date.now());
  }
  note(VOLO, 'Volo', 'A cheerful thief.');
});

describe('findUnlinkedMentions', () => {
  it('finds a whole-word, case-insensitive mention with a snippet around it', () => {
    note('Lore/tales.md', 'Tales', 'We met volo the thief at the inn last night.');

    const [hit] = findUnlinkedMentions({ groupId: G, role: 'editor', path: VOLO });

    expect(hit).toEqual({
      path: 'Lore/tales.md',
      title: 'Tales',
      snippet: 'We met volo the thief at the inn last night.',
    });
  });

  it('trims a long snippet to roughly 80 characters around the match', () => {
    note('Lore/long.md', 'Long', `${'word '.repeat(40)}Volo ${'more '.repeat(40)}`);

    const [hit] = findUnlinkedMentions({ groupId: G, role: 'editor', path: VOLO });

    expect(hit?.snippet.startsWith('…')).toBe(true);
    expect(hit?.snippet.endsWith('…')).toBe(true);
    expect(hit?.snippet).toContain('Volo');
    expect(hit!.snippet.length).toBeLessThan(100);
  });

  it('ignores a substring inside another word', () => {
    note('Lore/evolution.md', 'Evolution', 'Evolution is a slow process, and Volox is unrelated.');

    expect(find()).toEqual([]);
  });

  it('matches an alias', () => {
    getDb().query('INSERT INTO aliases (group_id, alias, path) VALUES (?, ?, ?)').run(G, 'Volothamp', VOLO);
    note('Lore/sage.md', 'Sage', 'The sage Volothamp Geddarm wrote guides.');

    expect(find()).toEqual(['Lore/sage.md']);
  });

  it('ignores a title under four letters', () => {
    note('People/Bo.md', 'Bo', 'Bo is a dog.');
    note('Lore/dogs.md', 'Dogs', 'We all love Bo, the dog.');

    expect(find('editor', 'People/Bo.md')).toEqual([]);
  });

  it('excludes the Note itself and Notes already linked in either direction', () => {
    note('Lore/out.md', 'Out', 'Volo is here.');
    note('Lore/in.md', 'In', 'Volo is here too.');
    note('Lore/free.md', 'Free', 'And Volo is here.');
    link(VOLO, 'Lore/out.md');
    link('Lore/in.md', VOLO);

    expect(find()).toEqual(['Lore/free.md']);
  });

  it('hides a dm_only mentioning Note from a viewer but not an editor', () => {
    note('Lore/secret.md', 'Secret', 'The GM knows Volo is a spy.', { dmOnly: true });

    expect(find('viewer')).toEqual([]);
    expect(find('editor')).toEqual(['Lore/secret.md']);
  });

  it('returns nothing for a Note the caller cannot see', () => {
    note('People/Hidden.md', 'Hidden One', 'secret', { dmOnly: true });
    note('Lore/x.md', 'X', 'Hidden One appears here.');

    expect(find('viewer', 'People/Hidden.md')).toEqual([]);
  });

  it('stays inside the world', () => {
    note('Lore/elsewhere.md', 'Elsewhere', 'Volo is famous.', { group: OTHER_WORLD });

    expect(find()).toEqual([]);
  });

  it('orders by most recently updated and honours the cap', () => {
    for (let i = 0; i < 5; i++) note(`Lore/n${i}.md`, `N${i}`, 'Volo again.');

    expect(find('editor', VOLO, 3)).toEqual(['Lore/n4.md', 'Lore/n3.md', 'Lore/n2.md']);
    expect(find()).toHaveLength(5);
  });
});
