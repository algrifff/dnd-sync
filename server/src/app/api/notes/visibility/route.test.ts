import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { deriveFolderIndex } from '@/lib/campaign-index';
import { PATCH } from './route';

const folder = 'Campaigns/Demo/People';
let session: Session;
let adminSession: Session;

function indexBody(): string {
  return getDb()
    .query<{ content_md: string }, [string, string]>(
      'SELECT content_md FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(DEFAULT_GROUP_ID, `${folder}/index.md`)!.content_md;
}

function visibilityRequest(path: string, dmOnly: boolean, as: Session = session): NextRequest {
  const cookie = buildSessionCookies(as)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request('http://localhost/api/notes/visibility', {
    method: 'PATCH',
    headers: { cookie, 'x-csrf-token': as.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ path, dmOnly }),
  }) as unknown as NextRequest;
}

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({
    username: 'hider',
    displayName: 'Hider',
    password: 'correct-horse-battery',
    role: 'editor',
  });
  session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  const owner = await createUser({
    username: 'owner',
    displayName: 'Owner',
    password: 'correct-horse-battery',
    role: 'admin',
  });
  adminSession = createSession({ userId: owner.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
});
afterAll(() => teardownTestDb());

describe('PATCH /api/notes/visibility', () => {
  it('should drop a newly hidden note from its folder index', async () => {
    const path = `${folder}/Secret Traitor.md`;
    getDb()
      .query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                            content_md, yjs_state, frontmatter_json, byte_size,
                            updated_at, updated_by, created_at, created_by)
         VALUES (?, ?, ?, 'Secret Traitor', '{"type":"doc","content":[]}', '', '', NULL, '{}', 0, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), DEFAULT_GROUP_ID, path, Date.now(), session.userId, Date.now(), session.userId);
    await deriveFolderIndex(DEFAULT_GROUP_ID, folder, { userId: session.userId });
    expect(indexBody()).toContain('Secret Traitor');

    const res = await PATCH(visibilityRequest(path, true));

    expect({ status: res.status, listed: indexBody().includes('Secret Traitor') }).toEqual({
      status: 200,
      listed: false,
    });
  });

  it('should answer an editor exactly like a missing note when it is Private', async () => {
    const path = `${folder}/Private Plot.md`;
    getDb()
      .query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                            content_md, yjs_state, frontmatter_json, byte_size,
                            updated_at, updated_by, created_at, created_by, gm_only)
         VALUES (?, ?, ?, 'Private Plot', '{"type":"doc","content":[]}', '', '', NULL, '{}', 0, ?, ?, ?, ?, 1)`,
      )
      .run(randomUUID(), DEFAULT_GROUP_ID, path, Date.now(), session.userId, Date.now(), session.userId);

    const hidden = await PATCH(visibilityRequest(path, true));
    const missing = await PATCH(visibilityRequest(`${folder}/Nope.md`, true));
    const ownerRes = await PATCH(visibilityRequest(path, true, adminSession));

    expect({ status: hidden.status, body: await hidden.json(), owner: ownerRes.status }).toEqual({
      status: 404,
      body: await missing.json(),
      owner: 200,
    });
  });
});
