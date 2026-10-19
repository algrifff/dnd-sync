// lib/note-paths through its interface. One Note at SRC owns a row in
// every table that names a Note by path; each operation is then checked
// against every one of them. When you add a table keyed by a Note path,
// the schema guard at the bottom fails until it has a row in PATH_STATE.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as campaignIndex from './campaign-index';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { copyNote, deleteNotes, renameNotes } from './note-paths';

const G = 'g_note_paths';
const OTHER_G = 'g_note_paths_other';
const USER = 'u_note_paths';
const SRC = 'Lore/Volo.md';
const DST = 'Lore/Volothamp.md';
const COPY = 'Lore/Volo (copy).md';

type Value = string | number | null;
type Row = Record<string, Value>;

/** Inserts a row, filling any NOT NULL column without a default that
 *  the caller left out, so a seed names only the columns that matter. */
function insert(table: string, row: Row): void {
  const cols = getDb()
    .query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
      `PRAGMA table_info(${table})`,
    )
    .all();
  const full: Row = { ...row };
  for (const c of cols) {
    if (c.name in full || c.notnull === 0 || c.dflt_value !== null) continue;
    full[c.name] = /INT|REAL/i.test(c.type) ? 0 : 'x';
  }
  const names = Object.keys(full);
  getDb()
    .query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((n) => full[n] ?? null));
}

function seedNote(path: string, opts: { frontmatter?: object; body?: unknown[]; groupId?: string } = {}): void {
  insert('notes', {
    id: randomUUID(),
    group_id: opts.groupId ?? G,
    path,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    content_json: JSON.stringify({ type: 'doc', content: opts.body ?? [] }),
    content_text: 'volo',
    frontmatter_json: JSON.stringify(opts.frontmatter ?? {}),
    updated_at: 0,
    created_at: 0,
  });
}

const wikilink = (target: string): unknown => ({
  type: 'paragraph',
  content: [{ type: 'wikilink', attrs: { target, label: target, anchor: null, orphan: false } }],
});

function count(sql: string, ...params: Value[]): number {
  return getDb().query<{ n: number }, Value[]>(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params)!.n;
}

function proposalPaths(): string[] {
  const json = getDb()
    .query<{ j: string }, [string]>(
      "SELECT wrap_up_json AS j FROM session_notes WHERE group_id = ? AND note_path = 'Lore/Session.md'",
    )
    .get(G)!.j;
  const p = JSON.parse(json) as {
    sessionPath: string;
    mentions: Array<{ match: { path?: string } }>;
    relations: Array<{ from: { path?: string }; to: { path?: string } }>;
    suggestions: Array<{ characterPath: string }>;
  };
  return [
    ...p.mentions.map((m) => m.match.path ?? ''),
    ...p.relations.flatMap((r) => [r.from.path ?? '', r.to.path ?? '']),
    ...p.suggestions.map((s) => s.characterPath),
  ];
}

/** What happens to the state naming SRC when its Note is copied. */
type OnCopy = 'copied' | 'stays';
/** What happens to it when its Note is deleted. */
type OnDelete = 'removed' | 'cleared' | 'kept';

type PathState = {
  name: string;
  /** How many rows (or references) name `path`. SRC starts with one. */
  refs: (path: string) => number;
  onCopy: OnCopy;
  onDelete: OnDelete;
};

const col = (table: string, column: string, extra = ''): PathState['refs'] => (path) =>
  count(`${table} WHERE group_id = ? AND ${column} = ?${extra}`, G, path);

const PATH_STATE: PathState[] = [
  { name: 'notes.path', refs: col('notes', 'path'), onCopy: 'copied', onDelete: 'removed' },
  { name: 'notes_fts.path', refs: col('notes_fts', 'path'), onCopy: 'copied', onDelete: 'removed' },
  { name: 'note_links.from_path', refs: col('note_links', 'from_path'), onCopy: 'copied', onDelete: 'removed' },
  { name: 'note_links.to_path', refs: col('note_links', 'to_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'tags.path', refs: col('tags', 'path'), onCopy: 'copied', onDelete: 'removed' },
  { name: 'aliases.path', refs: col('aliases', 'path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'characters.note_path', refs: col('characters', 'note_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'character_campaigns.note_path', refs: col('character_campaigns', 'note_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'session_notes.note_path', refs: col('session_notes', 'note_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'items.note_path', refs: col('items', 'note_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'locations.note_path', refs: col('locations', 'note_path'), onCopy: 'stays', onDelete: 'removed' },
  // Derived from the child's frontmatter, so a delete leaves it as the
  // frontmatter has it.
  { name: 'locations.parent_path', refs: col('locations', 'parent_path'), onCopy: 'stays', onDelete: 'kept' },
  { name: 'creatures.note_path', refs: col('creatures', 'note_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'character_suggestions.character_path', refs: col('character_suggestions', 'character_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'character_suggestions.session_path', refs: col('character_suggestions', 'session_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'note_relations.from_path', refs: col('note_relations', 'from_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'note_relations.to_path', refs: col('note_relations', 'to_path'), onCopy: 'stays', onDelete: 'removed' },
  { name: 'note_relations.session_path', refs: col('note_relations', 'session_path'), onCopy: 'stays', onDelete: 'cleared' },
  {
    name: 'users.active_character_path',
    refs: (path) => count('users WHERE id = ? AND active_character_path = ?', USER, path),
    onCopy: 'stays',
    onDelete: 'cleared',
  },
  // The review drops a mention of a Note that is gone, so a delete
  // leaves the proposal alone.
  {
    name: 'session_notes.wrap_up_json',
    refs: (path) => proposalPaths().filter((p) => p === path).length / 4,
    onCopy: 'stays',
    onDelete: 'kept',
  },
  {
    name: 'linker body [[wikilink]]',
    refs: (path) =>
      getDb()
        .query<{ c: string }, [string]>(
          "SELECT content_json AS c FROM notes WHERE group_id = ? AND path = 'Lore/Linker.md'",
        )
        .get(G)!
        .c.includes(`"target":"${path}"`)
        ? 1
        : 0,
    onCopy: 'stays',
    onDelete: 'kept',
  },
];

/** Not Note paths, or not keyed to one Note: each says why. */
const NOT_NOTE_PATHS: Record<string, string> = {
  'folder_markers.path': 'a folder; renameNotes({ folder }) and deleteNotes({ folder }) carry it',
  'campaigns.folder_path': 'a folder; renameNotes({ folder }) carries it',
  'assets.original_path': 'the uploaded file name, not a Note',
  'characters.portrait_path': 'an asset, not a Note',
  'import_jobs.raw_zip_path': 'a temp file on disk',
};

function resetWorld(): void {
  const db = getDb();
  for (const t of [
    'note_relations', 'character_suggestions', 'character_campaigns', 'characters', 'session_notes',
    'items', 'locations', 'creatures', 'note_links', 'tags', 'aliases', 'folder_markers', 'campaigns', 'notes',
    'group_members',
  ]) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec('DELETE FROM notes_fts');
  db.query('UPDATE users SET active_character_path = NULL').run();
}

/** One row naming SRC in every place PATH_STATE lists. */
function seedWorld(): void {
  seedNote(SRC);
  seedNote('Lore/Other.md');
  seedNote('Lore/Child.md');
  seedNote('Lore/Session.md');
  seedNote('Lore/Linker.md', { body: [wikilink(SRC)] });
  insert('note_links', { group_id: G, from_path: SRC, to_path: 'Lore/Other.md' });
  insert('note_links', { group_id: G, from_path: 'Lore/Linker.md', to_path: SRC });
  insert('tags', { group_id: G, path: SRC, tag: 'merchant' });
  insert('aliases', { group_id: G, path: SRC, alias: 'Volo G' });
  insert('characters', { group_id: G, note_path: SRC, kind: 'character', display_name: 'Volo', updated_at: 0 });
  insert('character_campaigns', { group_id: G, note_path: SRC, campaign_slug: 'c' });
  insert('session_notes', { group_id: G, note_path: SRC, updated_at: 0 });
  insert('items', { group_id: G, note_path: SRC, name: 'Volo' });
  insert('locations', { group_id: G, note_path: SRC, name: 'Volo' });
  insert('locations', { group_id: G, note_path: 'Lore/Child.md', name: 'Child', parent_path: SRC });
  insert('creatures', { group_id: G, note_path: SRC, name: 'Volo' });
  const suggestion = { group_id: G, owner_user_id: USER, status: 'dismissed', created_at: 0 };
  insert('character_suggestions', { ...suggestion, id: 's1', session_path: 'Lore/Session.md', character_path: SRC });
  insert('character_suggestions', { ...suggestion, id: 's2', session_path: SRC, character_path: 'Lore/Other.md' });
  const relation = { group_id: G, created_at: 0 };
  insert('note_relations', { ...relation, from_path: SRC, relation: 'member_of', to_path: 'Lore/Other.md' });
  insert('note_relations', { ...relation, from_path: 'Lore/Child.md', relation: 'works_for', to_path: SRC });
  insert('note_relations', {
    ...relation, from_path: 'Lore/Child.md', relation: 'owns', to_path: 'Lore/Other.md', session_path: SRC,
  });
  insert('group_members', { group_id: G, user_id: USER, role: 'admin' });
  getDb().query('UPDATE users SET active_character_path = ? WHERE id = ?').run(SRC, USER);
  const existing = { type: 'existing', path: SRC };
  insert('session_notes', {
    group_id: G,
    note_path: 'Lore/Session.md',
    updated_at: 0,
    wrap_up_json: JSON.stringify({
      sessionPath: 'Lore/Session.md',
      generatedAt: 0,
      mentions: [{ id: 'm1', name: 'Volo', kind: 'person', match: { ...existing, certain: true }, historyEntry: 'x' }],
      relations: [{ id: 'r1', from: existing, relation: 'ally_of', to: existing }],
      suggestions: [{ id: 's1', characterPath: SRC, story: 'x', items: [] }],
    }),
  });
}

beforeAll(() => {
  setupTestDb();
  const db = getDb();
  for (const id of [G, OTHER_G]) db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, 0)').run(id, id);
  insert('users', { id: USER, username: 'note_paths', display_name: 'Paths', password_hash: 'x', created_at: 0 });
});
afterAll(() => teardownTestDb());

describe('renameNotes carries every path-keyed row', () => {
  beforeAll(async () => {
    resetWorld();
    seedWorld();
    expect(await renameNotes({ groupId: G, userId: USER, moves: [{ from: SRC, to: DST }] })).toEqual({ ok: true });
  });

  it.each(PATH_STATE.map((s) => [s.name, s] as const))('%s follows the Note', (_name, state) => {
    expect({ old: state.refs(SRC), new: state.refs(DST) }).toEqual({ old: 0, new: 1 });
  });
});

describe('copyNote copies what belongs to the copy', () => {
  beforeAll(async () => {
    resetWorld();
    seedWorld();
    expect(await copyNote({ groupId: G, userId: USER, from: SRC, to: COPY })).toEqual({ ok: true });
  });

  it.each(PATH_STATE.map((s) => [s.name, s] as const))('%s', (_name, state) => {
    expect({ original: state.refs(SRC), copy: state.refs(COPY) }).toEqual({
      original: 1,
      copy: state.onCopy === 'copied' ? 1 : 0,
    });
  });
});

describe('deleteNotes removes every row naming the Note', () => {
  beforeAll(async () => {
    resetWorld();
    seedWorld();
    await deleteNotes({ groupId: G, userId: USER, paths: [SRC] });
  });

  it.each(PATH_STATE.map((s) => [s.name, s] as const))('%s', (_name, state) => {
    expect(state.refs(SRC)).toBe(state.onDelete === 'kept' ? 1 : 0);
  });

  it('keeps the rows a cleared reference sat on', () => {
    expect(count("note_relations WHERE group_id = ? AND relation = 'owns'", G)).toBe(1);
    expect(count('users WHERE id = ?', USER)).toBe(1);
  });
});

describe('renameNotes', () => {
  beforeEach(() => resetWorld());

  it('should merge a stale link edge at the destination instead of failing', async () => {
    seedNote(SRC);
    seedNote('Lore/Linker.md', { body: [wikilink(SRC)] });
    insert('note_links', { group_id: G, from_path: 'Lore/Linker.md', to_path: SRC });
    insert('note_links', { group_id: G, from_path: 'Lore/Linker.md', to_path: DST });
    insert('note_links', { group_id: G, from_path: SRC, to_path: 'Lore/Linker.md' });
    insert('note_links', { group_id: G, from_path: DST, to_path: 'Lore/Linker.md' });

    const result = await renameNotes({ groupId: G, userId: USER, moves: [{ from: SRC, to: DST }] });

    expect(result).toEqual({ ok: true });
    expect(count('note_links WHERE group_id = ?', G)).toBe(2);
  });

  it('should keep a manual flag when a link merges into a dangling one', async () => {
    seedNote(SRC);
    seedNote('Lore/Linker.md');
    insert('note_links', { group_id: G, from_path: 'Lore/Linker.md', to_path: SRC, is_manual: 1 });
    insert('note_links', { group_id: G, from_path: 'Lore/Linker.md', to_path: DST, is_manual: 0 });

    await renameNotes({ groupId: G, userId: USER, moves: [{ from: SRC, to: DST }] });

    expect(getDb().query('SELECT to_path, is_manual FROM note_links WHERE group_id = ?').all(G)).toEqual([
      { to_path: DST, is_manual: 1 },
    ]);
  });

  it("should keep the moving Character's pending Suggestion over a stale one at the destination", async () => {
    const A = 'Party/A.md';
    const B = 'Party/B.md';
    seedNote(A);
    seedNote('Lore/Session.md');
    const suggestion = { group_id: G, session_path: 'Lore/Session.md', owner_user_id: USER, created_at: 0 };
    insert('character_suggestions', { ...suggestion, id: 'stale', character_path: B, status: 'dismissed' });
    insert('character_suggestions', { ...suggestion, id: 'live', character_path: A, status: 'pending' });

    const result = await renameNotes({ groupId: G, userId: USER, moves: [{ from: A, to: B }] });

    expect(result).toEqual({ ok: true });
    expect(
      getDb().query('SELECT id, character_path, status FROM character_suggestions WHERE group_id = ?').all(G),
    ).toEqual([{ id: 'live', character_path: B, status: 'pending' }]);
  });

  it("should keep the moving Session's Wrap-up over a stale row at the destination", async () => {
    seedNote(SRC);
    getDb().exec('PRAGMA foreign_keys = OFF');
    try {
      insert('session_notes', { group_id: G, note_path: DST, updated_at: 0, wrap_up_json: '{"stale":true}' });
    } finally {
      getDb().exec('PRAGMA foreign_keys = ON');
    }
    insert('session_notes', { group_id: G, note_path: SRC, updated_at: 0, wrap_up_json: '{"live":true}' });

    await renameNotes({ groupId: G, userId: USER, moves: [{ from: SRC, to: DST }] });

    expect(getDb().query('SELECT note_path, wrap_up_json FROM session_notes WHERE group_id = ?').all(G)).toEqual([
      { note_path: DST, wrap_up_json: '{"live":true}' },
    ]);
  });

  it('should not hand orphan tags or Relationships at the destination to the moved Note', async () => {
    seedNote(SRC);
    seedNote('Lore/Other.md');
    insert('tags', { group_id: G, path: SRC, tag: 'merchant' });
    insert('tags', { group_id: G, path: DST, tag: 'stale' });
    const relation = { group_id: G, created_at: 0, to_path: 'Lore/Other.md' };
    insert('note_relations', { ...relation, from_path: SRC, relation: 'member_of', session_path: 'Lore/S1.md' });
    insert('note_relations', { ...relation, from_path: DST, relation: 'member_of', session_path: 'Lore/Stale.md' });
    insert('note_relations', { ...relation, from_path: DST, relation: 'enemy_of' });

    await renameNotes({ groupId: G, userId: USER, moves: [{ from: SRC, to: DST }] });

    expect(getDb().query('SELECT tag FROM tags WHERE group_id = ?').all(G)).toEqual([{ tag: 'merchant' }]);
    expect(getDb().query('SELECT from_path, relation, session_path FROM note_relations WHERE group_id = ?').all(G)).toEqual([
      { from_path: DST, relation: 'member_of', session_path: 'Lore/S1.md' },
    ]);
  });

  it('should write nothing and report not_found when a source is gone', async () => {
    seedNote(SRC);

    const result = await renameNotes({
      groupId: G,
      userId: USER,
      moves: [{ from: SRC, to: DST }, { from: 'Lore/Gone.md', to: 'Lore/Here.md' }],
    });

    expect(result).toEqual({ ok: false, error: 'not_found', path: 'Lore/Gone.md' });
    expect(count('notes WHERE group_id = ? AND path = ?', G, SRC)).toBe(1);
  });

  it('should write nothing and report exists when a destination is taken', async () => {
    seedNote(SRC);
    seedNote(DST);

    const result = await renameNotes({ groupId: G, userId: USER, moves: [{ from: SRC, to: DST }] });

    expect(result).toEqual({ ok: false, error: 'exists', path: DST });
  });

  it('should roll the whole move back when inTransaction throws', async () => {
    seedNote(SRC);
    insert('tags', { group_id: G, path: SRC, tag: 'merchant' });

    const move = renameNotes({
      groupId: G,
      userId: USER,
      moves: [{ from: SRC, to: DST }],
      inTransaction: () => {
        throw new Error('caller refused');
      },
    });

    await expect(move).rejects.toThrow('caller refused');
    expect(col('notes', 'path')(SRC)).toBe(1);
    expect(col('tags', 'path')(SRC)).toBe(1);
  });

  it('should run inTransaction against the new path', async () => {
    seedNote(SRC);

    await renameNotes({
      groupId: G,
      userId: USER,
      moves: [{ from: SRC, to: DST }],
      inTransaction: () => {
        getDb().query('UPDATE notes SET gm_only = 1 WHERE group_id = ? AND path = ?').run(G, DST);
      },
    });

    expect(count('notes WHERE group_id = ? AND path = ? AND gm_only = 1', G, DST)).toBe(1);
  });

  it('should leave the same path in another World alone', async () => {
    seedNote(SRC);
    seedNote(SRC, { groupId: OTHER_G });
    insert('tags', { group_id: OTHER_G, path: SRC, tag: 'merchant' });

    await renameNotes({ groupId: G, userId: USER, moves: [{ from: SRC, to: DST }] });

    expect(count('tags WHERE group_id = ? AND path = ?', OTHER_G, SRC)).toBe(1);
    expect(count('notes WHERE group_id = ? AND path = ?', OTHER_G, SRC)).toBe(1);
  });

  it('should carry a folder: its Notes, markers, campaign row and [[Folder]] links, inside and out', async () => {
    seedNote('Campaigns/Old/People/Volo.md');
    seedNote('Campaigns/Old/People/Xan.md', { body: [wikilink('Campaigns/Old/People/Volo.md')] });
    seedNote('Lore/Linker.md', { body: [wikilink('Campaigns/Old/People')] });
    insert('note_links', { group_id: G, from_path: 'Campaigns/Old/People/Xan.md', to_path: 'Campaigns/Old/People/Volo.md' });
    insert('note_links', { group_id: G, from_path: 'Lore/Linker.md', to_path: 'Campaigns/Old/People' });
    insert('folder_markers', { group_id: G, path: 'Campaigns/Old', created_at: 0 });
    insert('folder_markers', { group_id: G, path: 'Campaigns/Old/People', created_at: 0 });
    insert('campaigns', { group_id: G, slug: 'old', name: 'Old', folder_path: 'Campaigns/Old' });

    const result = await renameNotes({
      groupId: G,
      userId: USER,
      moves: [
        { from: 'Campaigns/Old/People/Volo.md', to: 'Campaigns/New/People/Volo.md' },
        { from: 'Campaigns/Old/People/Xan.md', to: 'Campaigns/New/People/Xan.md' },
      ],
      folder: { from: 'Campaigns/Old', to: 'Campaigns/New' },
    });

    expect(result).toEqual({ ok: true });
    const body = (path: string): string =>
      getDb().query<{ c: string }, [string, string]>('SELECT content_json AS c FROM notes WHERE group_id = ? AND path = ?').get(G, path)!.c;
    expect(body('Campaigns/New/People/Xan.md')).toContain('"target":"Campaigns/New/People/Volo.md"');
    expect(body('Lore/Linker.md')).toContain('"target":"Campaigns/New/People"');
    const markers = getDb().query<{ path: string }, [string]>('SELECT path FROM folder_markers WHERE group_id = ? ORDER BY path').all(G);
    expect(markers.map((m) => m.path)).toEqual(['Campaigns/New', 'Campaigns/New/People']);
    expect(getDb().query('SELECT slug, folder_path FROM campaigns WHERE group_id = ?').all(G)).toEqual([
      { slug: 'new', folder_path: 'Campaigns/New' },
    ]);
  });
});

describe('copyNote', () => {
  beforeEach(() => resetWorld());

  it('should derive the copy\'s indexes from its frontmatter', async () => {
    seedNote(SRC, { frontmatter: { kind: 'item' } });

    await copyNote({ groupId: G, userId: USER, from: SRC, to: COPY });

    expect(col('items', 'note_path')(COPY)).toBe(1);
  });

  it('should take the given title and visibility', async () => {
    seedNote(SRC);
    getDb().query('UPDATE notes SET gm_only = 1, dm_only = 1 WHERE group_id = ? AND path = ?').run(G, SRC);

    await copyNote({ groupId: G, userId: USER, from: SRC, to: COPY, title: 'Copy', gmOnly: false });

    expect(
      getDb().query('SELECT title, dm_only, gm_only FROM notes WHERE group_id = ? AND path = ?').get(G, COPY),
    ).toEqual({ title: 'Copy', dm_only: 1, gm_only: 0 });
  });

  it('should report exists when the destination is taken', async () => {
    seedNote(SRC);
    seedNote(COPY);

    expect(await copyNote({ groupId: G, userId: USER, from: SRC, to: COPY })).toEqual({
      ok: false,
      error: 'exists',
      path: COPY,
    });
  });

  it('should report not_found when the source is gone', async () => {
    expect(await copyNote({ groupId: G, userId: USER, from: SRC, to: COPY })).toEqual({
      ok: false,
      error: 'not_found',
      path: SRC,
    });
  });
});

describe('deleteNotes', () => {
  beforeEach(() => resetWorld());

  it('should not hand a resolved Suggestion to a Note re-created at the same path', async () => {
    seedNote(SRC);
    insert('character_suggestions', {
      id: 's1', group_id: G, session_path: 'Lore/Session.md', character_path: SRC,
      owner_user_id: USER, status: 'dismissed', created_at: 0,
    });

    await deleteNotes({ groupId: G, userId: USER, paths: [SRC] });
    seedNote(SRC);

    expect(col('character_suggestions', 'character_path')(SRC)).toBe(0);
  });

  it("should drop a pending Suggestion for a deleted Character and keep the Session's others", async () => {
    seedNote(SRC);
    const suggestion = { group_id: G, session_path: 'Lore/Session.md', owner_user_id: USER, status: 'pending', created_at: 0 };
    insert('character_suggestions', { ...suggestion, id: 's1', character_path: SRC });
    insert('character_suggestions', { ...suggestion, id: 's2', character_path: 'Party/Other.md' });

    await deleteNotes({ groupId: G, userId: USER, paths: [SRC] });

    expect(getDb().query('SELECT id FROM character_suggestions WHERE group_id = ?').all(G)).toEqual([{ id: 's2' }]);
  });

  it("should clear a member's active Character when it is deleted", async () => {
    seedNote(SRC);
    insert('group_members', { group_id: G, user_id: USER, role: 'viewer' });
    getDb().query('UPDATE users SET active_character_path = ? WHERE id = ?').run(SRC, USER);

    await deleteNotes({ groupId: G, userId: USER, paths: [SRC] });

    expect(
      getDb().query('SELECT active_character_path AS p FROM users WHERE id = ?').get(USER),
    ).toEqual({ p: null });
  });

  it('should still delete and resolve when the folder index refresh fails', async () => {
    seedNote(SRC);
    const refresh = spyOn(campaignIndex, 'deriveFolderIndexesFor').mockRejectedValue(new Error('index broke'));
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await deleteNotes({ groupId: G, userId: USER, paths: [SRC] });

      expect(refresh).toHaveBeenCalled();
      expect(col('notes', 'path')(SRC)).toBe(0);
      expect(logged).toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
      logged.mockRestore();
    }
  });

  it('should drop the folder markers under a deleted folder', async () => {
    insert('folder_markers', { group_id: G, path: 'Lore', created_at: 0 });
    insert('folder_markers', { group_id: G, path: 'Lore/Deep', created_at: 0 });
    insert('folder_markers', { group_id: G, path: 'Lorekeeper', created_at: 0 });

    await deleteNotes({ groupId: G, userId: USER, paths: [], folder: 'Lore' });

    expect(getDb().query('SELECT path FROM folder_markers WHERE group_id = ?').all(G)).toEqual([{ path: 'Lorekeeper' }]);
  });
});

describe('schema guard', () => {
  it('should know every column that holds a path', () => {
    const db = getDb();
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_fts_%'",
      )
      .all();
    const pathColumns = tables.flatMap((t) =>
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${t.name})`)
        .all()
        .filter((c) => /(^|_)path$/.test(c.name))
        .map((c) => `${t.name}.${c.name}`),
    );
    const known = new Set([...PATH_STATE.map((s) => s.name), ...Object.keys(NOT_NOTE_PATHS)]);

    expect(pathColumns.filter((c) => !known.has(c)).sort()).toEqual([]);
  });
});
