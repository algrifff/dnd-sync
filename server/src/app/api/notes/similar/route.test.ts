import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { GET } from './route';

let viewer: Session;
let authorId = '';

function seed(path: string, title: string, dmOnly = false): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{}', '', '', x'00', ?, 0, ?, ?, ?, ?, ?, 0)`,
    )
    .run(randomUUID(), DEFAULT_GROUP_ID, path, title, JSON.stringify({ kind: 'person' }), now, authorId, now, authorId, dmOnly ? 1 : 0);
}

function request(name: string | null, session: Session | null): NextRequest {
  const cookie = session
    ? buildSessionCookies(session).map((c) => `${c.name}=${c.value}`).join('; ')
    : '';
  const url = new URL('http://localhost/api/notes/similar');
  if (name !== null) url.searchParams.set('name', name);
  return new NextRequest(url, { headers: { cookie } });
}

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({ username: 'typist', displayName: 'Typist', password: 'correct-horse-battery', role: 'viewer' });
  authorId = user.id;
  viewer = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  seed('People/kixxish.md', 'Kixxish');
  seed('People/bassos.md', 'Bassos', true);
});
afterAll(() => teardownTestDb());

describe('GET /api/notes/similar', () => {
  it('requires a session', async () => {
    expect((await GET(request('Kixish', null))).status).toBe(401);
  });

  it('returns the close-named Notes the caller can see', async () => {
    const res = await GET(request('Kixish', viewer));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      matches: [{ path: 'People/kixxish.md', title: 'Kixxish', kind: 'person', reason: 'close_spelling' }],
    });
  });

  it('does not reveal a Note hidden from the caller', async () => {
    const res = await GET(request('Basos', viewer));

    expect(await res.json()).toEqual({ matches: [] });
  });

  it('answers a missing or empty name with no matches', async () => {
    expect(await (await GET(request(null, viewer))).json()).toEqual({ matches: [] });
    expect(await (await GET(request('   ', viewer))).json()).toEqual({ matches: [] });
  });
});
