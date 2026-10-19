// POST /api/notes/create with Character kinds and the legacy aliases: what lands
// in frontmatter and in the `characters` index, and which a player may make.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { ensureDefaultTemplates } from '@/lib/templates';
import { POST as createNote } from './route';
import { PATCH as patchSheet } from '../sheet/route';

type Role = 'admin' | 'viewer';
const sessions = {} as Record<Role, Session>;
const userIds = {} as Record<Role, string>;

function request(role: Role, body: unknown): NextRequest {
  const session = sessions[role];
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const req = new Request('http://localhost/api/notes/create', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // The route reads GM mode through NextRequest.cookies.
  Object.assign(req, { cookies: { get: () => undefined } });
  return req as unknown as NextRequest;
}

async function create(role: Role, kind: string, name: string): Promise<{ status: number; body: unknown }> {
  const res = await createNote(request(role, { folder: 'World Lore/People', name, kind }));
  return { status: res.status, body: await res.json() };
}

/** What a created Note looks like to the readers that care about `role`. */
function shapeOf(path: string): Record<string, unknown> {
  const db = getDb();
  const note = db
    .query<{ frontmatter_json: string }, [string, string]>(
      'SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(DEFAULT_GROUP_ID, path);
  const fm = JSON.parse(note!.frontmatter_json) as Record<string, unknown>;
  const character = db
    .query<{ kind: string; player_user_id: string | null }, [string, string]>(
      'SELECT kind, player_user_id FROM characters WHERE group_id = ? AND note_path = ?',
    )
    .get(DEFAULT_GROUP_ID, path);
  return {
    kind: fm.kind,
    role: fm.role,
    template: fm.template,
    player: fm.player,
    character: character ?? null,
  };
}

beforeAll(async () => {
  setupTestDb();
  ensureDefaultTemplates();
  for (const role of ['admin', 'viewer'] as const) {
    const user = await createUser({
      username: `create-${role}`,
      displayName: role,
      password: 'correct-horse-battery',
      role,
    });
    userIds[role] = user.id;
    sessions[role] = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  }
});
afterAll(() => teardownTestDb());

describe('POST /api/notes/create with a Character kind', () => {
  it('should create a pc as a Character the player owns, indexed as a pc', async () => {
    const res = await create('viewer', 'pc', 'Aria');

    expect({ res, shape: shapeOf('World Lore/People/Aria.md') }).toEqual({
      res: { status: 201, body: { ok: true, path: 'World Lore/People/Aria.md' } },
      shape: {
        kind: 'character',
        role: 'pc',
        template: 'character',
        player: 'create-viewer',
        character: { kind: 'pc', player_user_id: userIds.viewer },
      },
    });
  });

  it('should give a player their own Character when they create kind character outside a pcs folder', async () => {
    const res = await create('viewer', 'character', 'Brin');
    const path = 'World Lore/People/Brin.md';
    const shape = shapeOf(path);

    // Ownership through `player` alone, not through being the creator:
    // a GM-only field (`ac`) still sticks once `created_by` is cleared.
    getDb().query('UPDATE notes SET created_by = NULL WHERE group_id = ? AND path = ?').run(DEFAULT_GROUP_ID, path);
    const patched = await patchSheet(request('viewer', { path, sheet: { ac: 17 } }));
    const ownsSheet = ((await patched.json()) as { sheet?: { ac?: number } }).sheet?.ac === 17;

    expect({ status: res.status, shape, ownsSheet }).toEqual({
      status: 201,
      shape: {
        kind: 'character',
        role: 'pc',
        template: 'character',
        player: 'create-viewer',
        character: { kind: 'pc', player_user_id: userIds.viewer },
      },
      ownsSheet: true,
    });
  });

  it('should create npc, ally and villain as a Person that keeps its role and has no characters row', async () => {
    const shapes: Record<string, unknown> = {};
    for (const kind of ['npc', 'ally', 'villain']) {
      const res = await create('admin', kind, `The ${kind}`);
      expect(res.status).toBe(201);
      shapes[kind] = shapeOf(`World Lore/People/The ${kind}.md`);
    }

    const person = (role: string) => ({ kind: 'person', role, template: 'person', player: undefined, character: null });
    expect(shapes).toEqual({ npc: person('npc'), ally: person('ally'), villain: person('villain') });
  });

  it('should refuse a player creating anything but a page, quest or their own Character', async () => {
    const results: Record<string, number> = {};
    for (const kind of ['npc', 'ally', 'villain', 'monster', 'excalidraw', 'item']) {
      results[kind] = (await create('viewer', kind, `Viewer ${kind}`)).status;
    }

    expect(results).toEqual({ npc: 403, ally: 403, villain: 403, monster: 403, excalidraw: 403, item: 403 });
  });
});
