import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID as groupId } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { applyWrapUp } from '@/lib/wrap-up';
import { GET as list } from './route';
import { POST as accept } from './[id]/accept/route';
import { POST as dismiss } from './[id]/dismiss/route';

const SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-11-the-mill.md';
const KARA = 'Campaigns/Ashfall/Characters/kara.md';

let owner: Session;
let karaPlayer: Session;
let otherPlayer: Session;

async function sessionFor(username: string, role: 'admin' | 'viewer'): Promise<Session> {
  const user = await createUser({ username, displayName: username, password: 'correct-horse-battery', role });
  return createSession({ userId: user.id, groupId, userAgent: null, ip: null });
}

function cookieOf(as: Session): string {
  return buildSessionCookies(as).map((c) => `${c.name}=${c.value}`).join('; ');
}

function req(method: 'GET' | 'POST', as: Session | null, csrf = true): NextRequest {
  const headers: Record<string, string> = {};
  if (as) {
    headers.cookie = cookieOf(as);
    if (csrf && method === 'POST') headers['x-csrf-token'] = as.csrfToken;
  }
  return new Request('http://localhost/api/suggestions', { method, headers }) as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function seed(path: string, title: string, frontmatter: Record<string, unknown>): void {
  const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] };
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), body, 'default');
  ydoc.getText('title').insert(0, title);
  const now = Date.now();
  const fm = JSON.stringify(frontmatter);
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 0, ?, ?, ?, ?, 0, 0)`,
    )
    .run(randomUUID(), groupId, path, title, JSON.stringify(body), title, Y.encodeStateAsUpdate(ydoc), fm, now, owner.userId, now, owner.userId);
  deriveAllIndexes({ groupId, notePath: path, frontmatterJson: fm });
}

async function listIds(as: Session): Promise<string[]> {
  const res = await list(req('GET', as));
  return ((await res.json()) as { suggestions: Array<{ id: string }> }).suggestions.map((s) => s.id);
}

beforeAll(async () => {
  setupTestDb();
  owner = await sessionFor('owner', 'admin');
  karaPlayer = await sessionFor('kara-player', 'viewer');
  otherPlayer = await sessionFor('other-player', 'viewer');
  getDb()
    .query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, 'ashfall', 'Ashfall', 'Campaigns/Ashfall', Date.now());
  seed(SESSION, 'The Mill', { kind: 'session', campaigns: ['ashfall'] });
  seed(KARA, 'Kara', { kind: 'character', player: 'kara-player', sheet: { name: 'Kara' } });
  await applyWrapUp({
    groupId, userId: owner.userId, role: 'admin', sessionPath: SESSION,
    proposal: {
      sessionPath: SESSION, generatedAt: 1, mentions: [],
      suggestions: [{ id: 's1', characterPath: KARA, story: 'Saved Bram.', items: [{ name: 'Rusted Key', quantity: 1 }] }],
    },
    decisions: { accepted: [], asNew: [] },
  });
});
afterAll(() => teardownTestDb());

describe('Suggestion routes', () => {
  it('reject anonymous callers', async () => {
    expect((await list(req('GET', null))).status).toBe(401);
    expect((await accept(req('POST', null), ctx('x'))).status).toBe(401);
    expect((await dismiss(req('POST', null), ctx('x'))).status).toBe(401);
  });

  it('reject a mutation without the CSRF token', async () => {
    const [id] = await listIds(karaPlayer);

    expect((await accept(req('POST', karaPlayer, false), ctx(id!))).status).toBe(403);
    expect((await dismiss(req('POST', karaPlayer, false), ctx(id!))).status).toBe(403);
  });

  it('list a Suggestion only for the Player it was addressed to', async () => {
    expect(await listIds(karaPlayer)).toHaveLength(1);
    expect(await listIds(otherPlayer)).toEqual([]);
    expect(await listIds(owner)).toEqual([]);
  });

  it('answer 404 to anyone else accepting or dismissing it', async () => {
    const [id] = await listIds(karaPlayer);

    for (const who of [otherPlayer, owner]) {
      expect((await accept(req('POST', who), ctx(id!))).status).toBe(404);
      expect((await dismiss(req('POST', who), ctx(id!))).status).toBe(404);
    }
    expect(await listIds(karaPlayer)).toEqual([id!]);
  });

  it('answer 404 to an id that does not exist', async () => {
    expect((await accept(req('POST', karaPlayer), ctx('nope'))).status).toBe(404);
  });

  it('let the Player accept once, and accepting again changes nothing', async () => {
    const [id] = await listIds(karaPlayer);

    const first = await accept(req('POST', karaPlayer), ctx(id!));
    const second = await accept(req('POST', karaPlayer), ctx(id!));

    expect(await first.json()).toEqual({ ok: true, changed: true });
    expect(await second.json()).toEqual({ ok: true, changed: false });
    expect(await listIds(karaPlayer)).toEqual([]);
  });

  it('answer 409 to dismissing a Suggestion that was accepted', async () => {
    const accepted = getDb()
      .query<{ id: string }, []>("SELECT id FROM character_suggestions WHERE status = 'accepted'")
      .get()!.id;

    const res = await dismiss(req('POST', karaPlayer), ctx(accepted));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_accepted' });
  });
});
