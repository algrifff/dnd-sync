import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { PATCH } from './route';

const sessions = {} as Record<'viewer' | 'editor' | 'admin', Session>;

function insertNote(path: string, flags: { dm_only?: number; gm_only?: number }): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, 'N', '{"type":"doc","content":[]}', '', '', NULL, '{"tags":["leaky"]}', 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      DEFAULT_GROUP_ID,
      path,
      Date.now(),
      sessions.admin.userId,
      Date.now(),
      sessions.admin.userId,
      flags.dm_only ?? 0,
      flags.gm_only ?? 0,
    );
}

function patch(session: Session, path: string): Promise<Response> {
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return PATCH(
    new Request('http://localhost/api/note-tags', {
      method: 'PATCH',
      headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ path, tags: ['probe'] }),
    }) as unknown as NextRequest,
  );
}

beforeAll(async () => {
  setupTestDb();
  for (const role of ['viewer', 'editor', 'admin'] as const) {
    const user = await createUser({
      username: role,
      displayName: role,
      password: 'correct-horse-battery',
      role,
    });
    sessions[role] = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  }
  insertNote('Lore/Open.md', {});
  insertNote('Lore/Private.md', { gm_only: 1 });
});
afterAll(() => teardownTestDb());

describe('PATCH /api/note-tags', () => {
  it('should answer a Private Note exactly like a missing one for an editor', async () => {
    const hidden = await patch(sessions.editor, 'Lore/Private.md');
    const missing = await patch(sessions.editor, 'Lore/Nope.md');

    expect({ status: hidden.status, body: await hidden.json() }).toEqual({
      status: 404,
      body: await missing.json(),
    });
  });

  it('should leave a Private Note tags untouched when an editor probes it', async () => {
    await patch(sessions.editor, 'Lore/Private.md');

    const row = getDb()
      .query<{ frontmatter_json: string }, [string]>(
        'SELECT frontmatter_json FROM notes WHERE path = ?',
      )
      .get('Lore/Private.md')!;
    expect(row.frontmatter_json).toBe('{"tags":["leaky"]}');
  });

  it('should let the owner tag a Private Note and an editor tag an open one', async () => {
    const priv = await patch(sessions.admin, 'Lore/Private.md');
    const open = await patch(sessions.editor, 'Lore/Open.md');

    expect([priv.status, open.status]).toEqual([200, 200]);
  });

  it('should refuse viewers', async () => {
    expect((await patch(sessions.viewer, 'Lore/Open.md')).status).toBe(403);
  });
});
