import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { createNote, nextFreePath, seedFrontmatter } from './create-note';
import { visibilityFor } from './notes';
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

describe('seedFrontmatter', () => {
  it('seeds a Character with nested and legacy flat keys, a player and no role', () => {
    const fm = seedFrontmatter({ kind: 'pc', title: 'Aria', username: 'rowan' });
    expect(fm.kind).toBe('character');
    expect(fm.template).toBe('character');
    expect(fm.player).toBe('rowan');
    expect(fm.role).toBeUndefined();
    const sheet = fm.sheet as Record<string, unknown>;
    expect(sheet.name).toBe('Aria');
    expect(sheet.ability_scores).toMatchObject({ str: expect.any(Number), cha: expect.any(Number) });
    expect(typeof sheet.str).toBe('number');
    expect(Array.isArray(sheet.classes)).toBe(true);
  });

  it('collapses legacy aliases through the shared kind table', () => {
    expect(seedFrontmatter({ kind: 'npc', title: 'Bram' }).kind).toBe('person');
    expect(seedFrontmatter({ kind: 'monster', title: 'Ooze' }).kind).toBe('creature');
    const villain = seedFrontmatter({ kind: 'villain', title: 'Vex' });
    expect((villain.sheet as Record<string, unknown>).disposition).toBe('hostile');
    expect(villain.player).toBeUndefined();
  });

  it('seeds Item and Location sheets with their name', () => {
    for (const kind of ['item', 'location'] as const) {
      const fm = seedFrontmatter({ kind, title: 'Thing' });
      expect(fm.kind).toBe(kind);
      expect((fm.sheet as Record<string, unknown>).name).toBe('Thing');
    }
  });

  it('keeps caller sheet fields over template defaults, and no name on a session', () => {
    const fm = seedFrontmatter({ kind: 'session', title: 'T', sheet: { date: '2026-01-02' } });
    const sheet = fm.sheet as Record<string, unknown>;
    expect(sheet.date).toBe('2026-01-02');
    expect('name' in sheet).toBe(false);
  });

  it('gives quests a bare kind and plain pages nothing', () => {
    expect(seedFrontmatter({ kind: 'quest', title: 'Q' })).toEqual({ kind: 'quest' });
    expect(seedFrontmatter({ kind: 'page', title: 'P' })).toEqual({});
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
      username: 'rowan',
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

  it('answers exists by default and takes the next free name on request', async () => {
    const path = 'Campaigns/mill/Lore/dup.md';
    await createNote(DEFAULT_GROUP_ID, { userId, path, kind: 'page', title: 'dup' });
    expect(await createNote(DEFAULT_GROUP_ID, { userId, path, kind: 'page', title: 'dup' })).toEqual({
      status: 'exists',
      path,
    });
    const next = await createNote(DEFAULT_GROUP_ID, {
      userId, path, kind: 'page', title: 'dup', onTaken: 'next-free', suffixTitle: true,
    });
    expect(next).toMatchObject({ status: 'created', path: 'Campaigns/mill/Lore/dup (2).md', title: 'dup (2)' });
  });

  it('still answers exists for a visible holder and renames past a hidden one', async () => {
    const path = 'Campaigns/mill/Lore/secret.md';
    await createNote(DEFAULT_GROUP_ID, { userId, path, kind: 'page', title: 's', gmOnly: true });
    const asViewer = await createNote(DEFAULT_GROUP_ID, {
      userId, path, kind: 'page', title: 's', onTaken: 'next-free', visibleTo: visibilityFor('viewer'),
    });
    expect(asViewer).toMatchObject({ status: 'created', path: 'Campaigns/mill/Lore/secret (2).md' });
    const asAdmin = await createNote(DEFAULT_GROUP_ID, {
      userId, path: 'Campaigns/mill/Lore/dup.md', kind: 'page', title: 'dup',
      onTaken: 'next-free', visibleTo: visibilityFor('admin'),
    });
    expect(asAdmin.status).toBe('exists');
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
