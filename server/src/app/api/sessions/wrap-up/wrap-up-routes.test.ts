import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { getSessionStatus } from '@/lib/sessions';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID as groupId } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { GET as getPending, POST as submit } from './route';
import { GET as getContext } from './context/route';
import { POST as apply } from './apply/route';

const SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-11-the-mill.md';
const SECRET_SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-12-the-vault.md';
const EMPTY_SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-13-quiet.md';
const BRAM = 'Campaigns/Ashfall/People/bram.md';
const SPY = 'Campaigns/Ashfall/People/the-spy.md';

let owner: Session;
let coGm: Session;
let player: Session;
let otherPlayer: Session;

async function sessionFor(username: string, role: 'admin' | 'editor' | 'viewer'): Promise<Session> {
  const user = await createUser({ username, displayName: username, password: 'correct-horse-battery', role });
  return createSession({ userId: user.id, groupId, userAgent: null, ip: null });
}

function cookieOf(as: Session): string {
  return buildSessionCookies(as).map((c) => `${c.name}=${c.value}`).join('; ');
}

function post(url: string, as: Session | null, body: unknown, csrf = true): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) {
    headers.cookie = cookieOf(as);
    if (csrf) headers['x-csrf-token'] = as.csrfToken;
  }
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }) as unknown as NextRequest;
}

function get(url: string, as: Session | null): NextRequest {
  const headers: Record<string, string> = as ? { cookie: cookieOf(as) } : {};
  return Object.assign(new Request(url, { headers }), {
    nextUrl: new URL(url),
  }) as unknown as NextRequest;
}

const url = (path: string, query = ''): string =>
  `http://localhost/api/sessions/wrap-up${path}?sessionPath=${encodeURIComponent(SESSION)}${query}`;

function seed(path: string, title: string, frontmatter: Record<string, unknown>, text: string, hidden = false): void {
  const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), body, 'default');
  ydoc.getText('title').insert(0, title);
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 0, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      randomUUID(), groupId, path, title, JSON.stringify(body), text, Y.encodeStateAsUpdate(ydoc),
      JSON.stringify(frontmatter), now, owner.userId, now, owner.userId, hidden ? 1 : 0,
    );
}

function bodyOf(path: string): string {
  return getDb()
    .query<{ content_json: string }, [string, string]>('SELECT content_json FROM notes WHERE group_id = ? AND path = ?')
    .get(groupId, path)!.content_json;
}

function titleOf(path: string): string {
  return getDb()
    .query<{ title: string }, [string, string]>('SELECT title FROM notes WHERE group_id = ? AND path = ?')
    .get(groupId, path)!.title;
}

function snapshot(): Array<{ path: string; content_json: string }> {
  return getDb()
    .query<{ path: string; content_json: string }, [string]>('SELECT path, content_json FROM notes WHERE group_id = ? ORDER BY path')
    .all(groupId);
}

type Stored = { generatedAt: number; mentions: Array<{ id: string; name: string }> };

/** Submits as `as` and returns the stored proposal, as a client would see it. */
async function submitOk(as: Session, body: unknown): Promise<Stored> {
  const res = await submit(post(url(''), as, body));
  if (res.status !== 201) throw new Error(`submit failed: ${res.status}`);
  return ((await res.json()) as { proposal: Stored }).proposal;
}

const proposal = (sessionPath = SESSION) => ({
  sessionPath,
  mentions: [
    { name: 'Bram', kind: 'person', match: { type: 'existing', path: BRAM, certain: true }, historyEntry: 'Gave the party the Rusted Key.' },
    { name: 'Rusted Key', kind: 'item', match: { type: 'new', title: 'Rusted Key', summary: 'Old and iron.' }, historyEntry: 'Handed over by Bram.' },
  ],
});

beforeAll(async () => {
  setupTestDb();
  owner = await sessionFor('owner', 'admin');
  coGm = await sessionFor('cogm', 'editor');
  player = await sessionFor('player-one', 'viewer');
  otherPlayer = await sessionFor('player-two', 'viewer');
  getDb()
    .query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, 'ashfall', 'Ashfall', 'Campaigns/Ashfall', Date.now());
  seed(SESSION, 'The Mill', { kind: 'session', campaigns: ['ashfall'] }, 'We met Bram at the Mill. Bram gave us the Rusted Key.');
  seed(SECRET_SESSION, 'The Vault', { kind: 'session', campaigns: ['ashfall'] }, 'The vault opened.', true);
  seed(EMPTY_SESSION, 'Quiet', { kind: 'session', campaigns: ['ashfall'] }, 'Nothing happened.');
  seed(BRAM, 'Bram', { kind: 'person' }, 'A miller.');
  seed(SPY, 'The Spy', { kind: 'person' }, 'Watches.', true);
});
afterAll(() => teardownTestDb());

describe('Wrap-up routes require a session and a CSRF token', () => {
  it('rejects anonymous callers', async () => {
    expect((await getPending(get(url(''), null))).status).toBe(401);
    expect((await getContext(get(url('/context'), null))).status).toBe(401);
    expect((await submit(post(url(''), null, proposal()))).status).toBe(401);
    expect((await apply(post(url('/apply'), null, { sessionPath: SESSION, generatedAt: 1, accepted: [] }))).status).toBe(401);
  });

  it('rejects a mutation without the CSRF token', async () => {
    expect((await submit(post(url(''), player, proposal(), false))).status).toBe(403);
    expect((await apply(post(url('/apply'), player, { sessionPath: SESSION, generatedAt: 1, accepted: [] }, false))).status).toBe(403);
  });
});

describe('POST /api/sessions/wrap-up', () => {
  it.each([
    ['the Owner', () => owner],
    ['a Co-GM', () => coGm],
    ['a Player', () => player],
  ])('lets %s submit a proposal for a Session they can see', async (_who, who) => {
    const res = await submit(post(url(''), who(), proposal()));

    expect(res.status).toBe(201);
    const { proposal: stored } = (await res.json()) as { proposal: { mentions: Array<{ id: string }> } };
    const ids = stored.mentions.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => !/^m\d+$/.test(id))).toBe(true);
  });

  it('rejects a malformed proposal with a snake_case error and the first problem', async () => {
    const bad = proposal();
    bad.mentions[0]!.historyEntry = '';

    const res = await submit(post(url(''), player, bad));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body', reason: 'mentions.0.historyEntry: String must contain at least 1 character(s)' });
  });

  it('answers 404 for a mention of a hidden Note exactly as for one that does not exist', async () => {
    const hidden = proposal();
    hidden.mentions[0]!.match = { type: 'existing', path: SPY, certain: true } as never;
    const missing = proposal();
    missing.mentions[0]!.match = { type: 'existing', path: 'Campaigns/Ashfall/People/ghost.md', certain: true } as never;

    const a = await submit(post(url(''), player, hidden));
    const b = await submit(post(url(''), player, missing));

    expect(a.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
    expect((await submit(post(url(''), coGm, hidden))).status).toBe(201);
  });

  it('answers 404 for a Secret Session a Player cannot see', async () => {
    const res = await submit(post(url('', ''), player, proposal(SECRET_SESSION)));

    expect(res.status).toBe(404);
    expect((await submit(post(url(''), coGm, proposal(SECRET_SESSION)))).status).toBe(201);
  });

  it('rejects a mention that targets a Session with 400', async () => {
    const bad = proposal();
    bad.mentions[0]!.match = { type: 'existing', path: SESSION, certain: true } as never;

    const res = await submit(post(url(''), player, bad));

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_mention_target');
  });
});

describe('GET /api/sessions/wrap-up', () => {
  it('shows another Player the pending proposal, minus Notes they cannot see', async () => {
    await submit(post(url(''), coGm, {
      sessionPath: SESSION,
      mentions: [
        { name: 'the spy', kind: 'person', match: { type: 'existing', path: SPY, certain: true }, historyEntry: 'Watched.' },
        ...proposal().mentions,
      ],
    }));

    const forPlayer = (await (await getPending(get(url(''), otherPlayer))).json()) as { proposal: { mentions: Array<{ name: string }> } };
    const forCoGm = (await (await getPending(get(url(''), coGm))).json()) as { proposal: { mentions: Array<{ name: string }> } };

    expect(forPlayer.proposal.mentions.map((m) => m.name)).toEqual(['Bram', 'Rusted Key']);
    expect(forCoGm.proposal.mentions.map((m) => m.name)).toEqual(['the spy', 'Bram', 'Rusted Key']);
  });

  it('names the Notes its existing matches point at, and only those the reader can see', async () => {
    const forPlayer = (await (await getPending(get(url(''), otherPlayer))).json()) as { existingTitles: Record<string, string> };
    const forCoGm = (await (await getPending(get(url(''), coGm))).json()) as { existingTitles: Record<string, string> };

    expect(forPlayer.existingTitles).toEqual({ [BRAM]: 'Bram' });
    expect(forCoGm.existingTitles).toEqual({ [SPY]: 'The Spy', [BRAM]: 'Bram' });
  });

  it('echoes the proposal generatedAt, which apply requires back', async () => {
    const stored = await submitOk(player, proposal());

    const fetched = (await (await getPending(get(url(''), otherPlayer))).json()) as { proposal: Stored };

    expect(fetched.proposal.generatedAt).toBe(stored.generatedAt);
  });

  it('shows a Player ids with no gaps where a Secret Note was dropped from the middle', async () => {
    const stored = await submitOk(coGm, {
      sessionPath: SESSION,
      mentions: [proposal().mentions[0], { name: 'the spy', kind: 'person', match: { type: 'existing', path: SPY, certain: true }, historyEntry: 'Watched.' }, proposal().mentions[1]],
    });

    const forPlayer = (await (await getPending(get(url(''), otherPlayer))).json()) as { proposal: Stored };

    expect(forPlayer.proposal.mentions.map((m) => m.id)).toEqual([stored.mentions[0]!.id, stored.mentions[2]!.id]);
    expect(forPlayer.proposal.mentions.map((m) => m.id).every((id) => !/^m\d+$/.test(id))).toBe(true);
  });

  it('answers 404 for a Secret Session a Player cannot see', async () => {
    const res = await getPending(get(`http://localhost/api/sessions/wrap-up?sessionPath=${encodeURIComponent(SECRET_SESSION)}`, player));

    expect(res.status).toBe(404);
  });
});

describe('GET /api/sessions/wrap-up/context', () => {
  it('gives a Player the log and only the Notes they can see', async () => {
    const res = await getContext(get(url('/context'), player));

    const body = (await res.json()) as { log: string; candidates: Array<{ path: string; title: string; kind: string; recorded: boolean }> };
    expect(res.status).toBe(200);
    expect(body.log).toContain('We met Bram at the Mill.');
    expect(body.candidates).toEqual([{ path: BRAM, title: 'Bram', kind: 'person', recorded: false }]);
  });

  it('gives a Co-GM the Secret Notes too', async () => {
    const body = (await (await getContext(get(url('/context'), coGm))).json()) as { candidates: Array<{ path: string }> };

    expect(body.candidates.map((c) => c.path)).toEqual([BRAM, SPY]);
  });

  it('rejects a limit past the maximum with 400', async () => {
    expect((await getContext(get(url('/context', '&limit=9999'), player))).status).toBe(400);
  });
});

describe('POST /api/sessions/wrap-up/apply', () => {
  it('has a Player apply the ticked mentions, which closes the Session, and a second apply changes nothing', async () => {
    const stored = await submitOk(player, proposal());
    const body = { sessionPath: SESSION, generatedAt: stored.generatedAt, accepted: stored.mentions.map((m) => m.id) };

    const first = await apply(post(url('/apply'), otherPlayer, body));
    const afterFirst = snapshot();
    const second = await apply(post(url('/apply'), otherPlayer, body));

    expect(first.status).toBe(200);
    expect(((await first.json()) as { applied: unknown[] }).applied).toHaveLength(2);
    expect(getSessionStatus(groupId, SESSION)).toBe('closed');
    expect(bodyOf(BRAM)).toContain('Gave the party the Rusted Key.');
    expect(bodyOf('Campaigns/Ashfall/Loot/rusted-key.md')).toContain('Handed over by Bram.');
    expect(titleOf('Campaigns/Ashfall/Loot/rusted-key.md')).toBe('Rusted Key');
    expect(bodyOf(SESSION)).toContain('"type":"wikilink"');
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'no_pending_proposal' });
    expect(snapshot()).toEqual(afterFirst);
  });

  it('proposes only what is new on a re-run of a Closed Session', async () => {
    const ctx = (await (await getContext(get(url('/context'), player))).json()) as {
      session: { status: string };
      candidates: Array<{ path: string; recorded: boolean }>;
    };

    expect(ctx.session.status).toBe('closed');
    expect(ctx.candidates.map((c) => [c.path, c.recorded])).toEqual([
      [BRAM, true],
      ['Campaigns/Ashfall/Loot/rusted-key.md', true],
    ]);
  });

  it('answers 409 when there is no pending proposal', async () => {
    const res = await apply(post(url('/apply'), coGm, { sessionPath: EMPTY_SESSION, generatedAt: 1, accepted: [] }));

    expect(res.status).toBe(409);
    expect(getSessionStatus(groupId, EMPTY_SESSION)).toBe('open');
  });

  it('answers 404 to a Player applying on a Secret Session', async () => {
    const stored = await submitOk(coGm, proposal(SECRET_SESSION));

    const res = await apply(post(url('/apply'), player, { sessionPath: SECRET_SESSION, generatedAt: stored.generatedAt, accepted: [stored.mentions[0]!.id] }));

    expect(res.status).toBe(404);
    expect(getSessionStatus(groupId, SECRET_SESSION)).toBe('open');
  });

  it('rejects a body with no accepted list, or with no generatedAt', async () => {
    const stored = await submitOk(player, proposal(EMPTY_SESSION));

    const noList = await apply(post(url('/apply'), player, { sessionPath: EMPTY_SESSION, generatedAt: stored.generatedAt }));
    const noStamp = await apply(post(url('/apply'), player, { sessionPath: EMPTY_SESSION, accepted: [] }));

    expect(noList.status).toBe(400);
    expect(noStamp.status).toBe(400);
  });

  it('answers 409 proposal_changed and writes nothing when the proposal was resubmitted after the closer fetched it', async () => {
    const reviewed = await submitOk(player, proposal(EMPTY_SESSION));
    await new Promise((r) => setTimeout(r, 2));
    const resubmitted = await submitOk(otherPlayer, proposal(EMPTY_SESSION));
    const before = snapshot();

    const stale = await apply(post(url('/apply'), player, {
      sessionPath: EMPTY_SESSION, generatedAt: reviewed.generatedAt, accepted: reviewed.mentions.map((m) => m.id),
    }));

    expect(resubmitted.generatedAt).not.toBe(reviewed.generatedAt);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'proposal_changed' });
    expect(snapshot()).toEqual(before);
    expect(getSessionStatus(groupId, EMPTY_SESSION)).toBe('open');

    const fresh = await apply(post(url('/apply'), player, {
      sessionPath: EMPTY_SESSION, generatedAt: resubmitted.generatedAt, accepted: [],
    }));
    expect(fresh.status).toBe(200);
  });
});
