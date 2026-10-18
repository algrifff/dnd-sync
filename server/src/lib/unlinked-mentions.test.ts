import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { findUnlinkedMentions, findWholeWord, mayContainTerm } from './unlinked-mentions';

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

  it('finds a mention of a title written with a decomposed accent', () => {
    const RHUN = 'Places/rhun.md';
    note(RHUN, 'Rhûn', 'A sea far to the east.');
    note('Lore/map.md', 'Map', 'The road runs east to Rhûn and the inland sea.');

    expect(find('editor', RHUN)).toEqual(['Lore/map.md']);
  });

  it('skips a title too long to be a name, without scanning for it', () => {
    const LONG = 'Lore/long-title.md';
    const title = `${'aaaa '.repeat(20_000)}x`;
    note(LONG, title, 'Nothing here.');
    note('Lore/echo.md', 'Echo', `${'aaaa '.repeat(40_000)}x`);

    const started = performance.now();
    expect(find('editor', LONG)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
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

  it('finds a real mention that follows a hit preceded by a letter', () => {
    note('Lore/mixed.md', 'Mixed', 'The Volonte family arrived. Later we met Volo at the inn.');

    expect(find()).toEqual(['Lore/mixed.md']);
  });

  it('ignores a term embedded in a longer word, and treats regex characters literally', () => {
    note('Lore/embedded.md', 'Embedded', 'Volonte and Xvolo and volo_x only.');
    note('Lore/dot.md', 'Dot', 'A. B. (c)+ is not Volo.');

    expect(find()).toEqual(['Lore/dot.md']);
  });

  it('is not crowded out by more than 200 newer stemmed near-misses', () => {
    note('Lore/old.md', 'Old', 'We climbed the Tower at dawn.');
    for (let n = 0; n < 230; n++) note(`Lore/towering-${n}.md`, `T${n}`, 'A towering figure loomed.');
    note('Places/Tower.md', 'Tower', 'A stone keep.');

    expect(find('editor', 'Places/Tower.md')).toEqual(['Lore/old.md']);
  });

  it('matches a multi-word title across a newline, a double space or an NBSP', () => {
    note('Places/Black Tower.md', 'Black Tower', 'A dark keep.');
    note('Lore/newline.md', 'Newline', 'We reached the Black\nTower at dusk.');
    note('Lore/double.md', 'Double', 'We reached the black  tower at dusk.');
    note('Lore/nbsp.md', 'Nbsp', 'We reached the Black Tower at dusk.');

    expect(find('editor', 'Places/Black Tower.md').sort()).toEqual([
      'Lore/double.md',
      'Lore/nbsp.md',
      'Lore/newline.md',
    ]);
  });

  it('cuts the snippet from the right place after characters that lowercase longer', () => {
    note('Lore/dotted.md', 'Dotted', `${'İ'.repeat(60)} then we met Volo at the inn.`);

    const [hit] = findUnlinkedMentions({ groupId: G, role: 'editor', path: VOLO });

    expect(hit?.snippet).toContain('Volo');
  });
});

describe('mayContainTerm', () => {
  it('skips a Note without the first word, case-insensitively', () => {
    expect(mayContainTerm('Nothing to see here', 'Black Tower')).toBe(false);
    expect(mayContainTerm('the BLACK door', 'Black Tower')).toBe(true);
    expect(mayContainTerm('anything', '   ')).toBe(false);
  });
});

describe('findWholeWord', () => {
  it('returns indexes into the original text even when lowercasing changes its length', () => {
    const text = `${'İ'.repeat(60)} Volo`;
    const m = findWholeWord(text, 'volo');

    expect(m).not.toBeNull();
    expect(text.slice(m!.index, m!.index + m!.length)).toBe('Volo');
  });

  it('spans the whole whitespace run in the text', () => {
    const text = 'the Black \n Tower.';
    const m = findWholeWord(text, 'Black Tower');

    expect(text.slice(m!.index, m!.index + m!.length)).toBe('Black \n Tower');
  });

  it('rejects a match flanked by a word character', () => {
    expect(findWholeWord('Blacktower and Black Towers', 'Black Tower')).toBeNull();
  });

  it('treats a combining mark after the term as part of the word', () => {
    // "Zoë" written decomposed: e + U+0308, as macOS vault imports often are.
    expect(findWholeWord('We met Zoë at dawn', 'Zoe')).toBeNull();
    expect(findWholeWord('We met Zoe at dawn', 'Zoe')).not.toBeNull();
  });
});
