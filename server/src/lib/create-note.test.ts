import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { createNote, nextFreePath, type CreateNoteOpts } from './create-note';
import { createUser, DEFAULT_GROUP_ID } from './users';
import { ensureDefaultTemplates } from './templates';

let userId: string;

beforeAll(async () => {
  setupTestDb();
  ensureDefaultTemplates();
  const user = await createUser({
    username: 'rowan',
    displayName: 'Rowan',
    password: 'correct-horse-battery',
    role: 'viewer',
  });
  userId = user.id;
});

afterAll(() => teardownTestDb());

function fmAt(path: string): Record<string, unknown> {
  const row = getDb()
    .query<{ frontmatter_json: string }, [string, string]>(
      'SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(DEFAULT_GROUP_ID, path);
  return JSON.parse(row!.frontmatter_json);
}

let seedN = 0;
/** Seeded frontmatter of a fresh Note, as stored. */
async function seed(
  kind: CreateNoteOpts['kind'],
  title: string,
  extra: { player?: string; sheet?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const path = `World Lore/Seed/n${++seedN}.md`;
  const made = await createNote(DEFAULT_GROUP_ID, { userId, path, kind, title, ...extra });
  expect(made.status).toBe('created');
  return fmAt(path);
}

describe('seeded frontmatter', () => {
  it('should seed a pc as a Character with a player and role pc', async () => {
    const fm = await seed('pc', 'Aria', { player: 'rowan' });
    expect({ kind: fm.kind, template: fm.template, player: fm.player, role: fm.role }).toEqual({
      kind: 'character',
      template: 'character',
      player: 'rowan',
      role: 'pc',
    });
  });

  it('should give a canonical character no role', async () => {
    expect((await seed('character', 'Brin', { player: 'rowan' })).role).toBeUndefined();
  });

  it('should write a new Character sheet in both nested and legacy flat shapes', async () => {
    const fm = await seed('character', 'Aria', {
      player: 'rowan',
      sheet: { hp_max: 24, hp_current: 20, ac: 15, speed: 35, class: 'Rogue', level: 3, str: 14 },
    });
    expect(fm.sheet).toMatchObject({
      name: 'Aria',
      hit_points: { max: 24, current: 20, temporary: 0 },
      armor_class: { value: 15 },
      speed: { walk: 35 },
      ability_scores: { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      classes: [{ ref: { name: 'Rogue' }, level: 3 }],
      hp_max: 24,
      hp_current: 20,
      ac: 15,
      str: 14,
      class: 'Rogue',
      level: 3,
    });
  });

  it('should nest template-default AC and speed on a bare Character', async () => {
    const fm = await seed('pc', 'Cato', { player: 'rowan' });
    expect(fm.sheet).toMatchObject({
      armor_class: { value: 10 },
      speed: { walk: 30 },
      ac: 10,
      ability_scores: { str: 10, cha: 10 },
      str: 10,
    });
  });

  it('should collapse legacy aliases through the shared kind table and keep their role', async () => {
    const npc = await seed('npc', 'Bram');
    const villain = await seed('villain', 'Vex');
    const ooze = await seed('monster', 'Ooze');
    expect({
      npc: [npc.kind, npc.role],
      villain: [villain.kind, villain.role, (villain.sheet as Record<string, unknown>).disposition, villain.player],
      ooze: [ooze.kind, ooze.role],
    }).toEqual({
      npc: ['person', 'npc'],
      villain: ['person', 'villain', 'hostile', undefined],
      ooze: ['creature', undefined],
    });
  });

  it('should seed Item and Location sheets with their name', async () => {
    for (const kind of ['item', 'location'] as const) {
      const fm = await seed(kind, 'Thing');
      expect([fm.kind, (fm.sheet as Record<string, unknown>).name]).toEqual([kind, 'Thing']);
    }
  });

  it('should keep caller sheet fields over template defaults, and no name on a session', async () => {
    const sheet = (await seed('session', 'T', { sheet: { date: '2026-01-02' } })).sheet as Record<string, unknown>;
    expect([sheet.date, 'name' in sheet]).toEqual(['2026-01-02', false]);
  });

  it('should give quests a bare kind and plain pages nothing', async () => {
    expect([await seed('quest', 'Q'), await seed('page', 'P')]).toEqual([{ kind: 'quest' }, {}]);
  });

});

describe('nextFreePath', () => {
  it('skips taken paths', async () => {
    await createNote(DEFAULT_GROUP_ID, { userId, path: 'Campaigns/x/Lore/free.md', kind: 'page', title: 'free' });
    await createNote(DEFAULT_GROUP_ID, { userId, path: 'Campaigns/x/Lore/free (2).md', kind: 'page', title: 'free' });
    expect(nextFreePath(DEFAULT_GROUP_ID, 'Campaigns/x/Lore/free.md')).toBe('Campaigns/x/Lore/free (3).md');
    expect(nextFreePath(DEFAULT_GROUP_ID, 'Campaigns/x/Lore/free.md', (n) => `-${n}`)).toBe(
      'Campaigns/x/Lore/free-2.md',
    );
  });
});

describe('createNote', () => {
  it('inserts, derives the characters index, and returns the path', async () => {
    const made = await createNote(DEFAULT_GROUP_ID, {
      userId,
      player: 'rowan',
      path: 'Campaigns/mill/Characters/Aria.md',
      kind: 'pc',
      title: 'Aria',
    });
    expect(made.status).toBe('created');
    expect(fmAt('Campaigns/mill/Characters/Aria.md').kind).toBe('character');
    const idx = getDb()
      .query<{ player_user_id: string | null }, [string, string]>(
        'SELECT player_user_id FROM characters WHERE group_id = ? AND note_path = ?',
      )
      .get(DEFAULT_GROUP_ID, 'Campaigns/mill/Characters/Aria.md');
    expect(idx?.player_user_id).toBe(userId);
  });

  it('answers exists by default and retries where onTaken points', async () => {
    const path = 'Campaigns/mill/Lore/dup.md';
    await createNote(DEFAULT_GROUP_ID, { userId, path, kind: 'page', title: 'dup' });
    expect(await createNote(DEFAULT_GROUP_ID, { userId, path, kind: 'page', title: 'dup' })).toEqual({
      status: 'exists',
      path,
    });
    const taken: Array<[string, number]> = [];
    const next = await createNote(DEFAULT_GROUP_ID, {
      userId, path, kind: 'page', title: 'dup',
      onTaken: (at, n) => {
        taken.push([at, n]);
        return { path: `Campaigns/mill/Lore/dup (${n}).md`, title: `dup (${n})` };
      },
    });
    expect({ next, taken }).toMatchObject({
      next: { status: 'created', path: 'Campaigns/mill/Lore/dup (2).md', title: 'dup (2)' },
      taken: [[path, 2]],
    });
  });

  it('answers exists when onTaken gives up', async () => {
    const path = 'Campaigns/mill/Lore/dup.md';
    const made = await createNote(DEFAULT_GROUP_ID, { userId, path, kind: 'page', title: 'dup', onTaken: () => null });
    expect(made).toEqual({ status: 'exists', path });
  });

  it('writes a markdown body and the dm_only flag', async () => {
    const path = 'Campaigns/mill/Lore/hidden.md';
    await createNote(DEFAULT_GROUP_ID, { userId, path, kind: 'lore', title: 'Hidden', markdown: 'Body text', dmOnly: true });
    const row = getDb()
      .query<{ dm_only: number; content_md: string }, [string, string]>(
        'SELECT dm_only, content_md FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(DEFAULT_GROUP_ID, path);
    expect(row?.dm_only).toBe(1);
    expect(row?.content_md).toContain('Body text');
    expect(fmAt(path).kind).toBe('lore');
  });
});
