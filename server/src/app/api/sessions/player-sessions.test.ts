import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { canEditDoc } from '@/collab/server';
import { getDb } from '@/lib/db';
import { getSessionStatus } from '@/lib/sessions';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { POST as createSessionNote } from './create/route';
import { POST as markClosed } from './mark-closed/route';

let gm: Session;
let player: Session;
let otherPlayer: Session;

async function sessionFor(username: string, role: 'editor' | 'viewer'): Promise<Session> {
  const user = await createUser({
    username,
    displayName: username,
    password: 'correct-horse-battery',
    role,
  });
  return createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
}

function post(url: string, as: Session, body: unknown): NextRequest {
  const cookie = buildSessionCookies(as)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request(url, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': as.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function seedNote(
  path: string,
  createdBy: string,
  frontmatter: Record<string, unknown>,
  hidden: { dmOnly?: boolean; gmOnly?: boolean } = {},
): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      DEFAULT_GROUP_ID,
      path,
      path,
      JSON.stringify(frontmatter),
      now,
      createdBy,
      now,
      createdBy,
      hidden.dmOnly ? 1 : 0,
      hidden.gmOnly ? 1 : 0,
    );
}

beforeAll(async () => {
  setupTestDb();
  gm = await sessionFor('cogm', 'editor');
  player = await sessionFor('player-one', 'viewer');
  otherPlayer = await sessionFor('player-two', 'viewer');
  getDb()
    .query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(DEFAULT_GROUP_ID, 'ashfall', 'Ashfall', 'Campaigns/Ashfall', Date.now());
});
afterAll(() => teardownTestDb());

describe('Players run Sessions', () => {
  it('a Player opens a Session another Player can co-write and close', async () => {
    const created = await createSessionNote(
      post('http://localhost/api/sessions/create', player, {
        campaignSlug: 'ashfall',
        date: '2026-10-11',
        title: 'The Mill',
      }),
    );
    expect(created.status).toBe(201);
    const { path } = (await created.json()) as { path: string };

    expect(canEditDoc(path, otherPlayer)).toBe(true);

    const closed = await markClosed(
      post('http://localhost/api/sessions/mark-closed', otherPlayer, { sessionPath: path }),
    );
    expect(closed.status).toBe(200);
    expect(getSessionStatus(DEFAULT_GROUP_ID, path)).toBe('closed');
  });

  it("a Player still cannot edit another member's non-session Note", () => {
    seedNote('Campaigns/Ashfall/People/Innkeeper.md', gm.userId, { kind: 'person' });

    expect(canEditDoc('Campaigns/Ashfall/People/Innkeeper.md', player)).toBe(false);
  });

  it('closing a Secret or Private Session 404s for a Player and leaves it open', async () => {
    seedNote('Campaigns/Ashfall/Adventure Log/secret.md', gm.userId, { kind: 'session' }, { dmOnly: true });
    seedNote('Campaigns/Ashfall/Adventure Log/private.md', gm.userId, { kind: 'session' }, { gmOnly: true });

    for (const sessionPath of [
      'Campaigns/Ashfall/Adventure Log/secret.md',
      'Campaigns/Ashfall/Adventure Log/private.md',
    ]) {
      const res = await markClosed(
        post('http://localhost/api/sessions/mark-closed', player, { sessionPath }),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
      expect(getSessionStatus(DEFAULT_GROUP_ID, sessionPath)).toBe('open');
    }
  });

  it('closing a Secret Session still works for a Co-GM', async () => {
    seedNote('Campaigns/Ashfall/Adventure Log/gm-secret.md', gm.userId, { kind: 'session' }, { dmOnly: true });

    const res = await markClosed(
      post('http://localhost/api/sessions/mark-closed', gm, {
        sessionPath: 'Campaigns/Ashfall/Adventure Log/gm-secret.md',
      }),
    );

    expect(res.status).toBe(200);
  });
});
