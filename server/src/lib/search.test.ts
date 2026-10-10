import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { searchWorld, type UiSearchResult } from './search';
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from './search-snippet';
import { setupTestDb, teardownTestDb } from './test-utils';

const WORLD = 'search-world';
const OTHER = 'search-other';

function seedNote(
  groupId: string,
  path: string,
  title: string,
  body: string,
  opts: { kind?: string; dmOnly?: boolean; gmOnly?: boolean } = {},
): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, frontmatter_json, dm_only, gm_only, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(), groupId, path, title, body,
      JSON.stringify(opts.kind ? { kind: opts.kind } : {}),
      opts.dmOnly ? 1 : 0, opts.gmOnly ? 1 : 0, Date.now(),
    );
}

function seedAsset(groupId: string, name: string, gmOnly = false): void {
  getDb()
    .query(
      `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_at, gm_only)
       VALUES (?, ?, ?, 'image/png', 1, ?, ?, ?)`,
    )
    .run(randomUUID(), groupId, randomUUID(), name, Date.now(), gmOnly ? 1 : 0);
}

function search(q: string, role: 'admin' | 'editor' | 'viewer' = 'admin', gmMode = false): UiSearchResult[] {
  return searchWorld({ q, groupId: WORLD, role, gmMode });
}

function labels(results: UiSearchResult[]): string[] {
  return results.map((r) => (r.kind === 'note' ? `${r.match}:${r.title}` : `asset:${r.name}`));
}

beforeAll(() => {
  setupTestDb();
});
afterAll(() => {
  teardownTestDb();
});
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM notes; DELETE FROM assets; DELETE FROM groups;');
  for (const id of [WORLD, OTHER]) {
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, id, Date.now());
  }
});

describe('searchWorld', () => {
  it('ranks a title match above notes that only mention the name in their body', () => {
    seedNote(WORLD, 'Sessions/Session 4.md', 'Session 4', 'Gandrel Gandrel Gandrel betrayed the party');
    seedNote(WORLD, 'Characters/Gandrel.md', 'Gandrel', 'A wizard.', { kind: 'pc' });

    const results = search('gandrel');

    expect(labels(results)).toEqual(['title:Gandrel', 'content:Session 4']);
    expect(results[0]).toMatchObject({ kind: 'note', path: 'Characters/Gandrel.md', noteKind: 'pc' });
  });

  it('matches titles mid-word and orders prefix matches first', () => {
    seedNote(WORLD, 'Locations/Ashgrove.md', 'Ashgrove', '');
    seedNote(WORLD, 'Locations/Grove of Thorns.md', 'Grove of Thorns', '');

    expect(labels(search('grove'))).toEqual(['title:Grove of Thorns', 'title:Ashgrove']);
  });

  it('requires every word of a multi-word query in the title', () => {
    seedNote(WORLD, 'a.md', 'Red Dragon Inn', '');
    seedNote(WORLD, 'b.md', 'Red Keep', '');

    expect(labels(search('dragon red'))).toEqual(['title:Red Dragon Inn']);
  });

  it('matches accented titles regardless of case and accents', () => {
    seedNote(WORLD, 'People/Éowyn.md', 'Éowyn of Rohan', '');

    expect(labels(search('éowyn'))).toEqual(['title:Éowyn of Rohan']);
    expect(labels(search('EOWYN'))).toEqual(['title:Éowyn of Rohan']);
  });

  it('still returns a note whose frontmatter is malformed JSON', () => {
    getDb()
      .query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text, frontmatter_json, updated_at)
         VALUES (?, ?, 'broken.md', 'Broken Bridge', '{}', 'a broken bridge', '{not json', ?)`,
      )
      .run(randomUUID(), WORLD, Date.now());

    expect(labels(search('broken'))).toEqual(['title:Broken Bridge']);
    expect(labels(search('bridges'))).toEqual(['content:Broken Bridge']);
  });

  it('stems words that only appear in a title', () => {
    seedNote(WORLD, 'a.md', 'Red Dragon', '');

    expect(labels(search('dragons'))).toEqual(['content:Red Dragon']);
  });

  it('matches untitled notes on their file name, not their folders', () => {
    seedNote(WORLD, 'Characters/untitled.md', '', '');

    expect(search('characters')).toEqual([]);
    expect(labels(search('untit'))).toEqual(['title:untitled']);
  });

  it('skips body matches for queries shorter than three characters', () => {
    seedNote(WORLD, 'a.md', 'Tavern', 'go north');

    expect(search('go')).toEqual([]);
    expect(labels(search('nor'))).toEqual(['content:Tavern']);
  });

  it('marks snippet highlights with control characters, not HTML', () => {
    seedNote(WORLD, 'a.md', 'Tavern', '<b>beware</b> the basilisk');

    const [hit] = search('basilisk');

    expect(hit).toMatchObject({ kind: 'note', match: 'content' });
    expect(hit?.kind === 'note' && hit.snippet).toBe(
      `<b>beware</b> the ${SNIPPET_MARK_OPEN}basilisk${SNIPPET_MARK_CLOSE}`,
    );
  });

  it('finds assets by a substring of their file name', () => {
    seedAsset(WORLD, 'ashgrove-map.png');
    seedAsset(WORLD, 'portrait.png');

    expect(labels(search('MAP'))).toEqual(['asset:ashgrove-map.png']);
  });

  it('never returns another world’s notes or assets', () => {
    seedNote(OTHER, 'Gandrel.md', 'Gandrel', 'gandrel');
    seedAsset(OTHER, 'gandrel.png');

    expect(search('gandrel')).toEqual([]);
  });

  it('hides dm_only notes from viewers only', () => {
    seedNote(WORLD, 'secret.md', 'Secret Lair', 'lair of the lich', { dmOnly: true });

    expect(search('lair', 'viewer')).toEqual([]);
    expect(labels(search('lair', 'editor'))).toEqual(['title:Secret Lair']);
  });

  it('keeps the gm_only namespace separate from the player namespace', () => {
    seedNote(WORLD, 'gm.md', 'Lich Plan', 'phylactery', { gmOnly: true });
    seedNote(WORLD, 'player.md', 'Lich Rumours', '');
    seedAsset(WORLD, 'lich-secret.png', true);

    expect(labels(search('lich'))).toEqual(['title:Lich Rumours']);
    expect(labels(search('lich', 'admin', true))).toEqual(['title:Lich Plan', 'asset:lich-secret.png']);
  });
});
