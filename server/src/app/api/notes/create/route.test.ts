import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { POST } from './route';

let player: Session;

function createRequest(session: Session, body: unknown): NextRequest {
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new NextRequest('http://localhost/api/notes/create', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function frontmatterAt(path: string): unknown {
  const row = getDb()
    .query<{ frontmatter_json: string }, [string, string]>(
      'SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(DEFAULT_GROUP_ID, path);
  return row ? JSON.parse(row.frontmatter_json) : null;
}

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({
    username: 'quester',
    displayName: 'Quester',
    password: 'correct-horse-battery',
    role: 'viewer',
  });
  player = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
});
afterAll(() => teardownTestDb());

describe('POST /api/notes/create', () => {
  it('gives a quest created by a player the quest kind', async () => {
    const res = await POST(
      createRequest(player, { folder: 'Campaigns/mill/Quests', name: 'Find the Miller', kind: 'quest' }),
    );

    expect(res.status).toBe(201);
    expect(frontmatterAt('Campaigns/mill/Quests/Find the Miller.md')).toEqual({ kind: 'quest' });
  });
});
