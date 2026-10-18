import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { createWorld, listWorldsForSession } from '@/lib/groups';
import { PUT } from './route';

let session: Session;
let ownWorld: string;
let foreignWorld: string;

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({
    username: 'rail-user',
    displayName: 'Rail',
    password: 'correct-horse-battery',
    role: 'viewer',
  });
  const stranger = await createUser({
    username: 'rail-stranger',
    displayName: 'Stranger',
    password: 'correct-horse-battery',
    role: 'viewer',
  });
  session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  const strangerSession = createSession({
    userId: stranger.id,
    groupId: DEFAULT_GROUP_ID,
    userAgent: null,
    ip: null,
  });
  ownWorld = createWorld({ name: 'Zendikar', creatorUserId: user.id, sessionId: session.id });
  foreignWorld = createWorld({
    name: 'Ravnica',
    creatorUserId: stranger.id,
    sessionId: strangerSession.id,
  });
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  getDb().exec('UPDATE group_members SET sort_order = NULL');
});

function put(body: unknown, csrfToken: string = session.csrfToken): Promise<Response> {
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const req = new Request('http://localhost/api/worlds/order', {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return PUT(req as unknown as NextRequest);
}

function railIds(): string[] {
  return listWorldsForSession(session.userId, session.id).map((w) => w.id);
}

describe('PUT /api/worlds/order', () => {
  it('should save the order for the caller', async () => {
    const res = await put({ worldIds: [ownWorld, DEFAULT_GROUP_ID] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(railIds()).toEqual([ownWorld, DEFAULT_GROUP_ID]);
  });

  it('should reject a world the caller is not a member of', async () => {
    const res = await put({ worldIds: [ownWorld, foreignWorld] });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_world' });
    expect(railIds()).toEqual([DEFAULT_GROUP_ID, ownWorld]);
  });

  it('should reject a duplicated world id', async () => {
    const res = await put({ worldIds: [ownWorld, ownWorld, DEFAULT_GROUP_ID] });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    expect(railIds()).toEqual([DEFAULT_GROUP_ID, ownWorld]);
  });

  it('should refuse a request without the CSRF token', async () => {
    const res = await put({ worldIds: [ownWorld, DEFAULT_GROUP_ID] }, 'wrong-token');

    expect(res.status).toBe(403);
    expect(railIds()).toEqual([DEFAULT_GROUP_ID, ownWorld]);
  });
});
