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
       VALUES (?, ?, ?, 'Hero', '{"type":"doc","content":[]}', '', '', NULL, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      DEFAULT_GROUP_ID,
      path,
      JSON.stringify({ kind: 'item', sheet: { name: 'Hidden Blade' } }),
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
    new Request('http://localhost/api/notes/sheet', {
      method: 'PATCH',
      headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ path, sheet: {} }),
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
  insertNote('Items/Open.md', {});
  insertNote('Items/Secret.md', { dm_only: 1 });
  insertNote('Items/Private.md', { gm_only: 1 });
});
afterAll(() => teardownTestDb());

describe('PATCH /api/notes/sheet visibility', () => {
  it('should answer a Secret Note exactly like a missing one for a viewer', async () => {
    const hidden = await patch(sessions.viewer, 'Items/Secret.md');
    const missing = await patch(sessions.viewer, 'Items/Nope.md');

    expect({ status: hidden.status, body: await hidden.json() }).toEqual({
      status: 404,
      body: await missing.json(),
    });
  });

  it('should not echo a Private Note Sheet to an editor', async () => {
    const res = await patch(sessions.editor, 'Items/Private.md');

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Hidden Blade');
  });

  it('should let an editor patch a Secret Note and the owner patch a Private one', async () => {
    const secret = await patch(sessions.editor, 'Items/Secret.md');
    const priv = await patch(sessions.admin, 'Items/Private.md');

    expect([secret.status, priv.status]).toEqual([200, 200]);
  });

  it('should accept a viewer patching a visible Note (players edit their own Sheets)', async () => {
    const res = await patch(sessions.viewer, 'Items/Open.md');

    expect(res.status).toBe(200);
  });
});
