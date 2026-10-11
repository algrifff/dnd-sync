import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { DELETE, POST } from './route';

const sessions = {} as Record<'admin' | 'editor' | 'viewer', Session>;

function seedNote(path: string, flags: { dmOnly?: boolean; gmOnly?: boolean } = {}): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, '{}', 0, ?, NULL, ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), DEFAULT_GROUP_ID, path, path, Date.now(), Date.now(), flags.dmOnly ? 1 : 0, flags.gmOnly ? 1 : 0);
}

function linkRequest(
  method: 'POST' | 'DELETE',
  session: Session,
  body: { fromPath: string; toPath: string },
): NextRequest {
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request('http://localhost/api/notes/backlink', {
    method,
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function linkExists(fromPath: string, toPath: string): boolean {
  return !!getDb()
    .query('SELECT 1 FROM note_links WHERE group_id = ? AND from_path = ? AND to_path = ?')
    .get(DEFAULT_GROUP_ID, fromPath, toPath);
}

async function call(
  handler: typeof POST,
  method: 'POST' | 'DELETE',
  role: keyof typeof sessions,
  fromPath: string,
  toPath: string,
): Promise<{ status: number; body: unknown }> {
  const res = await handler(linkRequest(method, sessions[role], { fromPath, toPath }));
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  setupTestDb();
  for (const role of ['admin', 'editor', 'viewer'] as const) {
    const user = await createUser({
      username: `linker-${role}`,
      displayName: role,
      password: 'correct-horse-battery',
      role,
    });
    sessions[role] = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  }
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  getDb().exec('DELETE FROM note_links');
  getDb().exec('DELETE FROM notes');
  seedNote('A.md');
  seedNote('B.md');
  seedNote('DmSecret.md', { dmOnly: true });
  seedNote('GmSecret.md', { gmOnly: true });
});

describe('POST /api/notes/backlink', () => {
  it('should forbid a viewer from creating an edge', async () => {
    const res = await call(POST, 'POST', 'viewer', 'A.md', 'B.md');

    expect({ status: res.status, linked: linkExists('A.md', 'B.md') }).toEqual({ status: 403, linked: false });
  });

  it('should answer for a gm_only target exactly as for a missing one when the caller is an editor', async () => {
    const missing = await call(POST, 'POST', 'editor', 'A.md', 'Nope.md');
    const hidden = await call(POST, 'POST', 'editor', 'A.md', 'GmSecret.md');

    expect(hidden).toEqual(missing);
    expect(linkExists('A.md', 'GmSecret.md')).toBe(false);
  });

  it('should answer for a gm_only source exactly as for a missing one when the caller is an editor', async () => {
    const missing = await call(POST, 'POST', 'editor', 'Nope.md', 'B.md');
    const hidden = await call(POST, 'POST', 'editor', 'GmSecret.md', 'B.md');

    expect(hidden).toEqual(missing);
  });

  it('should let an editor link to a dm_only note', async () => {
    const res = await call(POST, 'POST', 'editor', 'A.md', 'DmSecret.md');

    expect({ status: res.status, linked: linkExists('A.md', 'DmSecret.md') }).toEqual({ status: 200, linked: true });
  });

  it('should let an admin link to a gm_only note', async () => {
    const res = await call(POST, 'POST', 'admin', 'A.md', 'GmSecret.md');

    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/notes/backlink', () => {
  function seedManualLink(fromPath: string, toPath: string): void {
    getDb()
      .query('INSERT INTO note_links (group_id, from_path, to_path, is_manual) VALUES (?, ?, ?, 1)')
      .run(DEFAULT_GROUP_ID, fromPath, toPath);
  }

  it('should forbid a viewer from removing an edge', async () => {
    seedManualLink('A.md', 'B.md');

    const res = await call(DELETE, 'DELETE', 'viewer', 'A.md', 'B.md');

    expect({ status: res.status, linked: linkExists('A.md', 'B.md') }).toEqual({ status: 403, linked: true });
  });

  it('should answer for a gm_only endpoint exactly as for a missing one when the caller is an editor', async () => {
    seedManualLink('A.md', 'GmSecret.md');

    const missing = await call(DELETE, 'DELETE', 'editor', 'A.md', 'Nope.md');
    const hidden = await call(DELETE, 'DELETE', 'editor', 'A.md', 'GmSecret.md');

    expect({ status: hidden.status, body: hidden.body }).toEqual({ status: 404, body: missing.body });
    expect(linkExists('A.md', 'GmSecret.md')).toBe(true);
  });

  it('should let an editor remove a manual edge', async () => {
    seedManualLink('A.md', 'B.md');

    const res = await call(DELETE, 'DELETE', 'editor', 'A.md', 'B.md');

    expect({ status: res.status, linked: linkExists('A.md', 'B.md') }).toEqual({ status: 200, linked: false });
  });
});
