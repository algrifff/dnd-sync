import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID as groupId } from '@/lib/users';
import { editDistance, findSimilarNotes, nameTokens } from './similar-names';

let authorId = '';

function seed(path: string, title: string, frontmatter: Record<string, unknown>, flags: { dmOnly?: boolean; gmOnly?: boolean } = {}): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{}', '', '', x'00', ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), groupId, path, title, JSON.stringify(frontmatter), now, authorId, now, authorId, flags.dmOnly ? 1 : 0, flags.gmOnly ? 1 : 0);
}

const find = (name: string, role: 'admin' | 'editor' | 'viewer' = 'admin', extra: { limit?: number; excludePath?: string } = {}) =>
  findSimilarNotes({ groupId, role, name, ...extra });
const titles = (name: string, role: 'admin' | 'editor' | 'viewer' = 'admin') => find(name, role).map((m) => m.title);

beforeAll(async () => {
  setupTestDb();
  authorId = (await createUser({ username: 'scribe', displayName: 'Scribe', password: 'correct-horse-battery', role: 'viewer' })).id;
  seed('People/kixxish.md', 'Kixxish', { kind: 'npc' });
  seed('Quests/find-solistra.md', 'Find Solistra', { kind: 'quest' });
  seed('Places/kingsport.md', 'Kingsport', { kind: 'location' });
  seed('Places/kingsport-docks.md', 'Kingsport Docks', { kind: 'location' });
  seed('People/diane-mythwell.md', 'Diane (Mythwell)', { kind: 'person' });
  seed('People/gundran.md', 'Gundran Rockseeker', { kind: 'person' });
  seed('People/cafe.md', 'Café Noir', {});
  seed('Sessions/kixish-day.md', 'Kixish', { kind: 'session' });
  seed('People/the-spy.md', 'Sylvanus Vex', { kind: 'person' }, { dmOnly: true });
  seed('Admin/scratch.md', 'Sylvanus Vexx', {}, { gmOnly: true });
  seed('People/brann.md', 'Brann', { kind: 'person' });
  getDb().query('INSERT INTO aliases (group_id, alias, path) VALUES (?, ?, ?)').run(groupId, 'The Black Hand', 'People/gundran.md');
});
afterAll(() => teardownTestDb());

describe('nameTokens', () => {
  it('lowercases, strips accents, a parenthetical, punctuation and stop words', () => {
    expect(nameTokens('The Café of  Noir (Old)!')).toEqual(['cafe', 'noir']);
  });

  it('keeps letters outside the Latin alphabet', () => {
    expect(nameTokens('Кирилл')).toEqual(['кирилл']);
  });
});

describe('editDistance', () => {
  it('counts a swap of neighbours as one edit', () => {
    expect(editDistance('kixish', 'kixsih')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('findSimilarNotes', () => {
  it('matches a name equal once normalised, ranked first', () => {
    const [first] = find('diane');

    expect(first).toEqual({ path: 'People/diane-mythwell.md', title: 'Diane (Mythwell)', kind: 'person', reason: 'same_name' });
    expect(find('the CAFE noir')[0]!.reason).toBe('same_name');
  });

  it('matches a one-letter typo in a name of 5 to 9 characters', () => {
    expect(find('Kixish').map((m) => [m.title, m.reason])).toEqual([['Kixxish', 'close_spelling']]);
    expect(titles('Brannn')).toEqual(['Brann']);
  });

  it('allows two edits only once the shorter name is 10 characters or more', () => {
    expect(titles('Find Shalistra')).toEqual(['Find Solistra']);
    expect(titles('Bran')).toEqual([]);
    expect(titles('Kxxsh')).toEqual([]);
  });

  it('matches a long word spelled one letter off inside a longer name', () => {
    expect(find('Gundren').map((m) => [m.title, m.reason])).toEqual([['Gundran Rockseeker', 'similar_word']]);
  });

  it('does not match one name that merely contains the other', () => {
    expect(titles('Kingsport Docks')).toEqual(['Kingsport Docks']);
    expect(titles('Kingsport Harbour')).toEqual([]);
    expect(titles('Rockseeker')).toEqual([]);
  });

  it('matches an alias and reports the Note by its title', () => {
    expect(find('The Black Hnad').map((m) => [m.title, m.reason])).toEqual([['Gundran Rockseeker', 'close_spelling']]);
  });

  it('never offers a Session', () => {
    expect(find('Kixish').every((m) => m.kind !== 'session')).toBe(true);
  });

  it('reads kind from the canonical table, and plain Notes as note', () => {
    expect(find('Kixxish')[0]!.kind).toBe('person');
    expect(find('Cafe Noir')[0]!.kind).toBe('note');
  });

  it('hides dm_only Notes from a viewer and gm_only Notes from everyone but the admin', () => {
    expect(titles('Sylvanus Vex', 'viewer')).toEqual([]);
    expect(titles('Sylvanus Vex', 'editor')).toEqual(['Sylvanus Vex']);
    expect(titles('Sylvanus Vex', 'admin')).toEqual(['Sylvanus Vex', 'Sylvanus Vexx']);
  });

  it('caps the matches and honours excludePath', () => {
    expect(find('Sylvanus Vex', 'admin', { limit: 1 })).toHaveLength(1);
    expect(find('Sylvanus Vex', 'admin', { excludePath: 'People/the-spy.md' }).map((m) => m.title)).toEqual(['Sylvanus Vexx']);
  });

  it('returns nothing for a name with no letters or digits', () => {
    expect(find('  ?! ')).toEqual([]);
    expect(find('the')).toEqual([]);
  });
});
