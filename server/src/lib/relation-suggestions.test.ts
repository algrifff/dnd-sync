import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import {
  fieldValues,
  formatSuggestions,
  isPlaceholder,
  stripWikilink,
  suggestRelations,
  type WorldSuggestions,
} from './relation-suggestions';

const W1 = 'world-one';
const W2 = 'world-two';

let dataDir: string;

type SeedOpts = { kind?: string; fm?: Record<string, unknown>; dmOnly?: boolean; gmOnly?: boolean };

function seed(groupId: string, path: string, title: string, opts: SeedOpts = {}): void {
  const frontmatter = { ...(opts.kind ? { kind: opts.kind } : {}), ...opts.fm };
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, frontmatter_json, updated_at, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
    )
    .run(randomUUID(), groupId, path, title, JSON.stringify(frontmatter), Date.now(), opts.dmOnly ? 1 : 0, opts.gmOnly ? 1 : 0);
}

const person = (title: string, fm: Record<string, unknown>, opts: SeedOpts = {}) =>
  seed(W1, `People/${title}.md`, title, { kind: 'person', fm, ...opts });

const lore = (title: string, groupId = W1, opts: SeedOpts = {}) =>
  seed(groupId, `Lore/${title}.md`, title, { kind: 'lore', ...opts });

function world(groupId = W1): WorldSuggestions {
  const found = suggestRelations(getDb()).find((w) => w.groupId === groupId);
  if (!found) throw new Error(`no world ${groupId}`);
  return found;
}

const lines = (w: WorldSuggestions) =>
  w.candidates.map((c) => `${c.from.title} ${c.relation} ${c.to.title} ${c.field} ${c.confidence}`);

beforeAll(() => {
  dataDir = setupTestDb();
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  for (const table of ['notes', 'aliases', 'note_relations', 'note_links', 'tags', 'groups']) {
    db.exec(`DELETE FROM ${table}`);
  }
  for (const id of [W1, W2]) {
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, `Name ${id}`, Date.now());
  }
});

describe('value normalisation', () => {
  it('strips the brackets, alias and heading from a wikilink', () => {
    expect(stripWikilink('[[Zhentarim|the Black Network]]')).toBe('Zhentarim');
    expect(stripWikilink('  [[ Ironmoore#History ]] ')).toBe('Ironmoore');
    expect(stripWikilink('  The Citadel ')).toBe('The Citadel');
  });

  it('reads a string, an array of strings, or nothing', () => {
    expect(fieldValues('A')).toEqual(['A']);
    expect(fieldValues(['A', 3, null, 'B'])).toEqual(['A', 'B']);
    expect(fieldValues(undefined)).toEqual([]);
    expect(fieldValues({ a: 1 })).toEqual([]);
  });

  it.each([
    '',
    '   ',
    '—',
    '–',
    '-',
    '--',
    'none',
    'None',
    'N/A',
    'n/a',
    'unknown',
    'Unknown',
    'Unknown (wizard; involved with Skelney events)',
    'unknown(hunter)',
    'None (carnival owner)',
  ])('treats %j as a placeholder', (value) => {
    expect(isPlaceholder(value)).toBe(true);
  });

  it.each(['Unknown demonic faction (Atoxis-aligned?)', 'Unknown bandit group', 'None of the Above', 'The Citadel'])(
    'does not treat %j as a placeholder',
    (value) => {
      expect(isPlaceholder(value)).toBe(false);
    },
  );
});

describe('suggestRelations', () => {
  it('proposes member_of for faction and located_in for location', () => {
    lore('Zhentarim');
    lore('Waterdeep');
    person('Volo', { faction: 'Zhentarim', location: 'Waterdeep' });

    expect(lines(world())).toEqual([
      'Volo member_of Zhentarim faction high',
      'Volo located_in Waterdeep location high',
    ]);
  });

  it('resolves a wikilink with an alias to the target Note', () => {
    lore('Zhentarim');
    person('Volo', { faction: '[[Zhentarim|the Black Network]]' });

    const w = world();
    expect(w.candidates.map((c) => c.to.path)).toEqual(['Lore/Zhentarim.md']);
    expect(w.counts.unresolved).toBe(0);
  });

  it('matches titles case-insensitively', () => {
    lore('House Fang');
    person('Luciana', { faction: 'house FANG' });

    expect(lines(world())).toEqual(['Luciana member_of House Fang faction high']);
  });

  it('falls back to the aliases table', () => {
    lore('Zhentarim');
    getDb().query('INSERT INTO aliases (group_id, alias, path) VALUES (?, ?, ?)').run(W1, 'Black Network', 'Lore/Zhentarim.md');
    person('Volo', { faction: 'black network' });

    expect(lines(world())).toEqual(['Volo member_of Zhentarim faction high']);
  });

  it('falls back to frontmatter aliases', () => {
    seed(W1, 'Lore/Zhentarim.md', 'Zhentarim', { kind: 'lore', fm: { aliases: ['The Black Network'] } });
    person('Volo', { faction: 'The Black Network' });

    expect(lines(world())).toEqual(['Volo member_of Zhentarim faction high']);
  });

  it('prefers a title match over an alias match', () => {
    lore('Zhentarim');
    seed(W1, 'Lore/Other.md', 'Other', { kind: 'lore', fm: { aliases: ['Zhentarim'] } });
    person('Volo', { faction: 'Zhentarim' });

    expect(world().candidates.map((c) => c.to.path)).toEqual(['Lore/Zhentarim.md']);
  });

  it('reports a value matching several Notes as ambiguous and never guesses', () => {
    seed(W1, 'Places/Citadel.md', 'The Citadel', { kind: 'location' });
    seed(W1, 'Lore/Citadel.md', 'The Citadel', { kind: 'lore' });
    person('Maid Mary', { location: 'The Citadel' });

    const w = world();
    expect(w.candidates).toEqual([]);
    expect(w.counts.ambiguous).toBe(1);
    expect(w.ambiguous[0]!.matches.map((m) => m.path).sort()).toEqual(['Lore/Citadel.md', 'Places/Citadel.md']);
  });

  it('reports a value matching several aliases as ambiguous', () => {
    seed(W1, 'Lore/A.md', 'A', { fm: { aliases: ['The Order'] } });
    seed(W1, 'Lore/B.md', 'B', { fm: { aliases: ['the order'] } });
    person('Volo', { faction: 'The Order' });

    expect(world().counts).toMatchObject({ ambiguous: 1, candidates: 0 });
  });

  it('falls back to the text before a trailing parenthetical, at lower confidence', () => {
    lore('The Citadel');
    person('Charlotte', { faction: 'The Citadel (East Battalion)' });

    const w = world();
    expect(lines(w)).toEqual(['Charlotte member_of The Citadel faction lower']);
    expect(w.candidates[0]!.value).toBe('The Citadel (East Battalion)');
  });

  it('prefers a Note titled with the whole parenthetical value', () => {
    lore('The Citadel');
    lore('The Citadel (East Battalion)');
    person('Charlotte', { faction: 'The Citadel (East Battalion)' });

    expect(lines(world())).toEqual(['Charlotte member_of The Citadel (East Battalion) faction high']);
  });

  it('reports a value with no match as unresolved, ranked by how many Notes use it', () => {
    person('A', { faction: 'Guards' });
    person('B', { faction: 'Guards' });
    person('C', { faction: 'guards' });
    person('D', { faction: 'Pirate Lords', location: 'Guards' });

    const w = world();
    expect(w.candidates).toEqual([]);
    expect(w.counts.unresolved).toBe(5);
    expect(w.unresolved).toEqual([
      { field: 'faction', value: 'Guards', count: 3 },
      { field: 'location', value: 'Guards', count: 1 },
      { field: 'faction', value: 'Pirate Lords', count: 1 },
    ]);
  });

  it('counts a placeholder in the summary and nothing else', () => {
    person('A', { faction: 'None (alchemist)', location: '—' });
    person('B', { faction: '' });

    const w = world();
    expect(w.counts).toMatchObject({ placeholders: 3, candidates: 0, unresolved: 0, ambiguous: 0 });
  });

  it('handles a list value, resolving each entry and ignoring non-strings', () => {
    lore('House Fang');
    lore('Council of the Comet');
    person('Luciana', { faction: ['House Fang', 'Nobody', 'unknown', 7, 'Council of the Comet'] });

    const w = world();
    expect(lines(w)).toEqual([
      'Luciana member_of House Fang faction high',
      'Luciana member_of Council of the Comet faction high',
    ]);
    expect(w.counts).toMatchObject({ unresolved: 1, placeholders: 1 });
  });

  it('never resolves to a Note in another world', () => {
    lore('Zhentarim', W2);
    person('Volo', { faction: 'Zhentarim' });

    expect(world(W1).candidates).toEqual([]);
    expect(world(W1).unresolved).toEqual([{ field: 'faction', value: 'Zhentarim', count: 1 }]);
    expect(world(W2).candidates).toEqual([]);
  });

  it('does not let a same-titled Note in another world make a match ambiguous', () => {
    lore('Zhentarim');
    lore('Zhentarim', W2);
    person('Volo', { faction: 'Zhentarim' });

    expect(world(W1).counts).toMatchObject({ candidates: 1, ambiguous: 0 });
  });

  it('does not use another world’s aliases or Relationships', () => {
    lore('Zhentarim');
    seed(W2, 'Lore/Other.md', 'Other', { kind: 'lore' });
    getDb().query('INSERT INTO aliases (group_id, alias, path) VALUES (?, ?, ?)').run(W2, 'Black Network', 'Lore/Zhentarim.md');
    getDb()
      .query(`INSERT INTO note_relations (group_id, from_path, relation, to_path, created_at) VALUES (?, ?, 'member_of', ?, ?)`)
      .run(W2, 'People/Volo.md', 'Lore/Zhentarim.md', Date.now());
    person('Volo', { faction: ['Black Network', 'Zhentarim'] });

    const w = world(W1);
    expect(lines(w)).toEqual(['Volo member_of Zhentarim faction high']);
    expect(w.counts.alreadyRecorded).toBe(0);
  });

  it('skips a candidate whose Relationship is already recorded', () => {
    lore('Zhentarim');
    lore('Waterdeep');
    person('Volo', { faction: 'Zhentarim', location: 'Waterdeep' });
    getDb()
      .query(`INSERT INTO note_relations (group_id, from_path, relation, to_path, created_at) VALUES (?, ?, 'member_of', ?, ?)`)
      .run(W1, 'People/Volo.md', 'Lore/Zhentarim.md', Date.now());

    const w = world();
    expect(lines(w)).toEqual(['Volo located_in Waterdeep location high']);
    expect(w.counts.alreadyRecorded).toBe(1);
  });

  it('never proposes a Note as its own target', () => {
    seed(W1, 'People/Zhentarim.md', 'Zhentarim', { kind: 'person', fm: { faction: 'Zhentarim' } });

    const w = world();
    expect(w.candidates).toEqual([]);
    expect(w.counts.selfReferences).toBe(1);
  });

  it('reads Person and Creature Notes only, including legacy kind aliases', () => {
    lore('Zhentarim');
    seed(W1, 'People/Npc.md', 'Npc', { kind: 'npc', fm: { faction: 'Zhentarim' } });
    seed(W1, 'Creatures/Wolf.md', 'Wolf', { kind: 'creature', fm: { faction: 'Zhentarim' } });
    seed(W1, 'Chars/Hero.md', 'Hero', { kind: 'character', fm: { faction: 'Zhentarim' } });
    seed(W1, 'Lore/Guild.md', 'Guild', { kind: 'lore', fm: { faction: 'Zhentarim' } });
    seed(W1, 'Misc/Plain.md', 'Plain', { fm: { faction: 'Zhentarim' } });

    expect(world().candidates.map((c) => c.from.title)).toEqual(['Wolf', 'Npc']);
  });

  it('marks a candidate when either end is hidden', () => {
    lore('Secret Cabal', W1, { gmOnly: true });
    lore('Waterdeep', W1, { dmOnly: true });
    lore('Neverwinter');
    person('Volo', { faction: 'Secret Cabal', location: 'Waterdeep' });
    person('Hidden Spy', { location: 'Neverwinter' }, { dmOnly: true });
    person('Plain Pete', { location: 'Neverwinter' });

    const hidden = Object.fromEntries(world().candidates.map((c) => [`${c.from.title} ${c.field}`, c.hidden]));
    expect(hidden).toEqual({
      'Volo faction': ['gm_only'],
      'Volo location': ['dm_only'],
      'Hidden Spy location': ['dm_only'],
      'Plain Pete location': [],
    });
  });

  it('limits to one world by id or by name, and rejects an unknown one', () => {
    lore('Zhentarim');
    person('Volo', { faction: 'Zhentarim' });

    expect(suggestRelations(getDb(), { group: W1 }).map((w) => w.groupId)).toEqual([W1]);
    expect(suggestRelations(getDb(), { group: `name ${W2}` }).map((w) => w.groupId)).toEqual([W2]);
    expect(() => suggestRelations(getDb(), { group: 'nope' })).toThrow('no world matches');
  });
});

describe('formatSuggestions', () => {
  it('prints readable candidate lines, hidden markers, the summary and the unresolved ranking', () => {
    lore('The Citadel');
    lore('Secret Cabal', W1, { gmOnly: true });
    person('Charlotte', { faction: 'The Citadel (East Battalion)', location: 'Guards' });
    person('Volo', { faction: 'Secret Cabal' });

    const text = formatSuggestions([world()]);
    expect(text).toContain('Charlotte -> member_of -> The Citadel  [faction, lower]');
    expect(text).toContain('Volo -> member_of -> Secret Cabal  [faction, high] [gm_only]');
    expect(text).toContain('Summary: 2 candidates, 0 ambiguous, 1 unresolved, 0 placeholder-skipped, 0 already recorded');
    expect(text).toMatch(/1 {2}location {2}Guards/);
  });
});

describe('read-only', () => {
  const tables = ['groups', 'notes', 'aliases', 'note_relations', 'note_links', 'tags'];
  const counts = () =>
    tables.map((t) => getDb().query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).all()[0]!.n);

  function seedWorld(): void {
    lore('Zhentarim');
    lore('Waterdeep');
    person('Volo', { faction: 'Zhentarim', location: 'Waterdeep' });
    person('Mary', { faction: 'Nobody' });
  }

  it('leaves every table untouched', () => {
    seedWorld();
    const before = counts();

    suggestRelations(getDb());

    expect(counts()).toEqual(before);
  });

  it('runs against a read-only connection, which would throw on any write', () => {
    seedWorld();
    const readonly = new BunDatabase(join(dataDir, 'compendium.db'), { readonly: true });
    try {
      expect(suggestRelations(readonly).find((w) => w.groupId === W1)!.counts.candidates).toBe(2);
    } finally {
      readonly.close();
    }
  });

  it('the script prints candidates as JSON and leaves the database file unchanged', () => {
    seedWorld();
    const file = join(dataDir, 'compendium.db');
    const digest = () => createHash('sha256').update(readFileSync(file)).digest('hex');
    const before = { counts: counts(), digest: digest() };

    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '../../scripts/suggest-relations.ts'), '--db', file, '--group', W1, '--json'],
      { env: { ...process.env, DATA_DIR: '/nonexistent' } },
    );

    expect(run.exitCode).toBe(0);
    const worlds = JSON.parse(run.stdout.toString()) as WorldSuggestions[];
    expect(worlds.map((w) => w.groupId)).toEqual([W1]);
    expect(worlds[0]!.candidates.map((c) => `${c.from.title} ${c.relation} ${c.to.title}`)).toEqual([
      'Volo member_of Zhentarim',
      'Volo located_in Waterdeep',
    ]);
    expect({ counts: counts(), digest: digest() }).toEqual(before);
  });

  it('the script exits non-zero for a missing database and documents itself in --help', () => {
    const script = join(import.meta.dir, '../../scripts/suggest-relations.ts');
    const missing = Bun.spawnSync([process.execPath, script, '--db', join(dataDir, 'missing.db')]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain('no database at');

    const help = Bun.spawnSync([process.execPath, script, '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain('writes nothing');
    expect(help.stdout.toString()).toContain('Wrap-up');
  });
});
