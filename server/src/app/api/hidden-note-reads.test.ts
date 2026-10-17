// Read surfaces that used to leak dm_only / gm_only notes (#83). One
// World with a viewer, an editor and an admin; a plain, a dm_only and a
// gm_only note of each indexed kind, each tagged. Every role must get
// exactly what `visibilityFor(role)` allows, and a hidden note must
// answer like a missing one.

import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID as groupId } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { GET as listCharacters } from './characters/route';
import { GET as suggest } from './notes/suggest/route';
import { GET as listTags } from './tags/route';
import { PATCH as patchSheet } from './notes/sheet/route';
import { PATCH as patchNoteTags } from './note-tags/route';

type Role = 'viewer' | 'editor' | 'admin';
const ROLES: readonly Role[] = ['viewer', 'editor', 'admin'];

const CHAR = {
  plain: 'Campaigns/Ashfall/Characters/plain-hero.md',
  dm: 'Campaigns/Ashfall/Characters/dm-hero.md',
  gm: 'Campaigns/Ashfall/Characters/gm-hero.md',
} as const;
const PLACE = {
  plain: 'Campaigns/Ashfall/Places/open-town.md',
  dm: 'Campaigns/Ashfall/Places/dm-town.md',
  gm: 'Campaigns/Ashfall/Places/gm-town.md',
} as const;
/** A dm_only note with no structured sheet: before the fix a viewer got
 *  400 `no_structured_sheet` here, which only an existing note produces. */
const DM_PLAIN_NOTE = 'Campaigns/Ashfall/dm-plain-note.md';
const MISSING = 'Campaigns/Ashfall/Characters/nobody.md';

type Level = 'plain' | 'dm' | 'gm';
const visibleLevels: Record<Role, Level[]> = {
  viewer: ['plain'],
  editor: ['plain', 'dm'],
  admin: ['plain', 'dm', 'gm'],
};

const sessions = {} as Record<Role, Session>;

function cookieOf(as: Session): string {
  return buildSessionCookies(as).map((c) => `${c.name}=${c.value}`).join('; ');
}

function get(as: Session, url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'GET',
    headers: { cookie: cookieOf(as) },
  });
}

function patch(as: Session, url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'PATCH',
    headers: { cookie: cookieOf(as), 'x-csrf-token': as.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seed(path: string, title: string, frontmatter: Record<string, unknown>, level: Level, tags: string[]): void {
  const now = Date.now();
  const fm = JSON.stringify(frontmatter);
  const db = getDb();
  db.query(
    `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                        yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                        created_at, created_by, dm_only, gm_only)
     VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), groupId, path, title, fm, now, sessions.admin.userId, now, sessions.admin.userId,
        level === 'dm' ? 1 : 0, level === 'gm' ? 1 : 0);
  for (const tag of tags) {
    db.query('INSERT INTO tags (group_id, path, tag) VALUES (?, ?, ?)').run(groupId, path, tag);
  }
  deriveAllIndexes({ groupId, notePath: path, frontmatterJson: fm });
}

function seedAsset(tag: string, gmOnly: boolean): void {
  const id = randomUUID();
  const db = getDb();
  db.query(
    `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_by, uploaded_at, gm_only)
     VALUES (?, ?, ?, 'image/png', 1, 'a.png', ?, ?, ?)`,
  ).run(id, groupId, randomUUID(), sessions.admin.userId, Date.now(), gmOnly ? 1 : 0);
  db.query('INSERT INTO asset_tags (group_id, asset_id, tag) VALUES (?, ?, ?)').run(groupId, id, tag);
}

function frontmatterOf(path: string): string {
  return getDb()
    .query<{ f: string }, [string, string]>('SELECT frontmatter_json AS f FROM notes WHERE group_id = ? AND path = ?')
    .get(groupId, path)!.f;
}

beforeAll(async () => {
  setupTestDb();
  for (const role of ROLES) {
    const user = await createUser({ username: `${role}-u`, displayName: role, password: 'correct-horse-battery', role });
    sessions[role] = createSession({ userId: user.id, groupId, userAgent: null, ip: null });
  }
  const names = { plain: 'Plain', dm: 'Dm', gm: 'Gm' } as const;
  for (const level of ['plain', 'dm', 'gm'] as const) {
    seed(CHAR[level], `${names[level]} Hero`, { kind: 'character', sheet: { name: `${names[level]} Hero` } }, level,
         ['party', `${level}-tag`]);
    seed(PLACE[level], `${names[level]} Town`, { kind: 'location', sheet: { name: `${names[level]} Town` } }, level,
         [`${level}-place-tag`]);
  }
  seed(DM_PLAIN_NOTE, 'DM Plain Note', { kind: 'note' }, 'dm', []);
  seedAsset('open-asset', false);
  seedAsset('gm-asset', true);
});
afterAll(() => teardownTestDb());

for (const role of ROLES) {
  describe(`as ${role}`, () => {
    const levels = visibleLevels[role];

    it('GET /api/characters lists only characters whose note the role may see', async () => {
      const res = await listCharacters(get(sessions[role], '/api/characters'));
      const body = (await res.json()) as { characters: Array<{ notePath: string }> };

      expect(body.characters.map((c) => c.notePath).sort()).toEqual(levels.map((l) => CHAR[l]).sort());
    });

    it('GET /api/notes/suggest suggests only characters the role may see', async () => {
      const res = await suggest(get(sessions[role], '/api/notes/suggest?kind=character&q=hero'));
      const body = (await res.json()) as { results: Array<{ path: string }> };

      expect(body.results.map((r) => r.path).sort()).toEqual(levels.map((l) => CHAR[l]).sort());
    });

    it('GET /api/notes/suggest with no query lists only locations the role may see', async () => {
      const res = await suggest(get(sessions[role], '/api/notes/suggest?kind=location'));
      const body = (await res.json()) as { results: Array<{ path: string }> };

      expect(body.results.map((r) => r.path).sort()).toEqual(levels.map((l) => PLACE[l]).sort());
    });

    it('GET /api/tags lists only tags on notes and assets the role may see', async () => {
      const res = await listTags(get(sessions[role], '/api/tags'));
      const body = (await res.json()) as { tags: Array<{ tag: string; count: number }> };

      const expected = [
        { tag: 'party', count: levels.length },
        ...levels.flatMap((l) => [`${l}-tag`, `${l}-place-tag`]).map((tag) => ({ tag, count: 1 })),
        { tag: 'open-asset', count: 1 },
        ...(role === 'admin' ? [{ tag: 'gm-asset', count: 1 }] : []),
      ];
      const byTag = (a: { tag: string }, b: { tag: string }): number => a.tag.localeCompare(b.tag);
      expect([...body.tags].sort(byTag)).toEqual(expected.sort(byTag));
    });
  });
}

describe('PATCH /api/notes/sheet', () => {
  async function outcome(as: Session, path: string): Promise<{ status: number; body: unknown }> {
    const res = await patchSheet(patch(as, '/api/notes/sheet', { path, sheet: {} }));
    return { status: res.status, body: await res.json() };
  }

  it('answers a hidden note exactly like a missing one', async () => {
    const missing = await outcome(sessions.viewer, MISSING);

    const hidden = [
      await outcome(sessions.viewer, CHAR.dm),
      await outcome(sessions.viewer, CHAR.gm),
      await outcome(sessions.viewer, DM_PLAIN_NOTE),
      await outcome(sessions.editor, CHAR.gm),
    ];

    expect(missing).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(hidden).toEqual([missing, missing, missing, missing]);
  });

  it('does not write a field into a hidden note', async () => {
    const before = frontmatterOf(CHAR.gm);

    await patchSheet(patch(sessions.editor, '/api/notes/sheet', { path: CHAR.gm, sheet: { level: 9 } }));

    expect(frontmatterOf(CHAR.gm)).toBe(before);
  });

  it('still returns the sheet of a note the caller may see', async () => {
    const res = await outcome(sessions.editor, CHAR.dm);

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/note-tags', () => {
  async function outcome(as: Session, path: string): Promise<{ status: number; body: unknown }> {
    const res = await patchNoteTags(patch(as, '/api/note-tags', { path, tags: ['renamed'] }));
    return { status: res.status, body: await res.json() };
  }

  it('answers an editor on a gm_only note exactly like a missing one', async () => {
    const missing = await outcome(sessions.editor, MISSING);

    const hidden = await outcome(sessions.editor, CHAR.gm);

    expect(missing).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(hidden).toEqual(missing);
  });

  it('leaves the hidden note tags untouched', async () => {
    await outcome(sessions.editor, PLACE.gm);

    const tags = getDb()
      .query<{ tag: string }, [string, string]>('SELECT tag FROM tags WHERE group_id = ? AND path = ?')
      .all(groupId, PLACE.gm)
      .map((r) => r.tag);
    expect(tags).toEqual(['gm-place-tag']);
  });

  it('still lets the admin retag a gm_only note', async () => {
    const scratch = 'Campaigns/Ashfall/gm-scratch.md';
    seed(scratch, 'GM Scratch', { kind: 'note' }, 'gm', []);

    const res = await outcome(sessions.admin, scratch);

    expect(res).toEqual({ status: 200, body: { ok: true, tags: ['renamed'] } });
  });
});
