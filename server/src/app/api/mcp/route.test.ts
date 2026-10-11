// End to end over the route handlers: register → consent (logged-in
// session) → token → MCP initialize → tools/list → tools/call, plus the
// ways a bearer token stops working.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { RELATION_TYPES } from '@compendium/shared';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { createWorld } from '@/lib/groups';
import { loadPendingWrapUp } from '@/lib/wrap-up';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { POST as register } from '../oauth/register/route';
import { POST as authorize } from '../oauth/authorize/route';
import { POST as token } from '../oauth/token/route';
import { POST as mcp } from './route';

const ORIGIN = 'https://compendium.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const NOTE_A = 'Campaigns/Dragon Heist/People/Volo.md';
const GANG = 'Campaigns/Dragon Heist/Lore/Xanathar Guild.md';
const NOTE_B = 'Campaigns/Other/People/Stranger.md';

let session: Session;
let userId: string;
let worldB: string;

function asNext(req: Request): NextRequest {
  return req as unknown as NextRequest;
}

function seedNote(groupId: string, path: string, body: string, kind = 'person'): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', ?, ?, NULL, ?, 0, ?, NULL, ?, NULL, 0, 0)`,
    )
    .run(randomUUID(), groupId, path, path.split('/').pop()!.replace(/\.md$/, ''), body, body, JSON.stringify({ kind }), Date.now(), Date.now());
}

async function obtainAccessToken(groupId: string, scope?: string): Promise<{ access: string; refresh: string; clientId: string }> {
  const reg = await register(
    asNext(new Request(`${ORIGIN}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
    })),
  );
  expect(reg.status).toBe(201);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const cookie = buildSessionCookies(session).map((c) => `${c.name}=${c.value}`).join('; ');
  const consent = await authorize(
    asNext(new Request(`${ORIGIN}/api/oauth/authorize`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        group_id: groupId,
        query: {
          response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's',
          code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/api/mcp`,
          ...(scope ? { scope } : {}),
        },
      }),
    })),
  );
  expect(consent.status).toBe(200);
  const code = new URL(((await consent.json()) as { redirect: string }).redirect).searchParams.get('code')!;

  const exchanged = await token(
    asNext(new Request(`${ORIGIN}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT,
        code_verifier: verifier, resource: `${ORIGIN}/api/mcp`,
      }).toString(),
    })),
  );
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
  return { access: tokens.access_token, refresh: tokens.refresh_token, clientId };
}

let nextId = 1;
async function rpc(access: string | null, method: string, params: unknown = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (access) headers.authorization = `Bearer ${access}`;
  return mcp(
    asNext(new Request(`${ORIGIN}/api/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    })),
  );
}

async function result<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`rpc error: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

type ToolCall = { content: { type: string; text: string }[]; isError?: boolean };

beforeAll(async () => {
  setupTestDb();
  process.env.PUBLIC_APP_URL = ORIGIN;
  const user = await createUser({ username: 'player', displayName: 'P', password: 'correct-horse-battery', role: 'viewer' });
  userId = user.id;
  session = createSession({ userId, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  worldB = createWorld({ name: 'World B', creatorUserId: userId, sessionId: session.id });
  seedNote(DEFAULT_GROUP_ID, NOTE_A, 'Volothamp Geddarm, chronicler.');
  seedNote(worldB, NOTE_B, 'Nobody from world A should read this.');
});
afterAll(() => {
  delete process.env.PUBLIC_APP_URL;
  teardownTestDb();
});

describe('POST /api/mcp without a usable token', () => {
  it('answers 401 with the RFC 9728 challenge when no token is sent', async () => {
    const res = await rpc(null, 'initialize');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="notes:read wrapup:submit"`,
    );
  });

  it('answers 401 invalid_token for a made-up token', async () => {
    const res = await rpc('nope', 'initialize');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('answers 401 once the access token has expired', async () => {
    const { access } = await obtainAccessToken(DEFAULT_GROUP_ID);
    getDb()
      .query('UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?')
      .run(Date.now() - 1, createHash('sha256').update(access).digest('hex'));
    expect((await rpc(access, 'initialize')).status).toBe(401);
  });
});

describe('register → authorize → token → MCP', () => {
  it('initializes, lists the tools and reads a note', async () => {
    const { access } = await obtainAccessToken(DEFAULT_GROUP_ID);

    const init = await result<{ protocolVersion: string; serverInfo: { name: string } }>(
      await rpc(access, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      }),
    );
    expect(init.serverInfo.name).toBe('compendium');

    const list = await result<{ tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }>(
      await rpc(access, 'tools/list'),
    );
    expect(list.tools.map((t) => t.name).sort()).toEqual(
      ['browse_notes', 'list_campaigns', 'note_neighbors', 'read_note', 'search_notes', 'submit_wrap_up', 'wrap_up_context'],
    );
    const writes = list.tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writes).toEqual(['submit_wrap_up']);
    const submitSchema = JSON.stringify(list.tools.find((t) => t.name === 'submit_wrap_up'));
    for (const type of RELATION_TYPES) expect(submitSchema).toContain(`"${type}"`);

    const read = await result<ToolCall>(
      await rpc(access, 'tools/call', { name: 'read_note', arguments: { path: NOTE_A } }),
    );
    expect(read.isError).toBeFalsy();
    expect(read.content[0]!.text).toContain('Volothamp Geddarm');
  });

  it('submits a Wrap-up proposal only with the wrapup:submit scope, and writes no note', async () => {
    const SESSION = 'Campaigns/Dragon Heist/Sessions/Session 1.md';
    seedNote(DEFAULT_GROUP_ID, SESSION, 'The party met Volo.', 'session');
    seedNote(DEFAULT_GROUP_ID, GANG, 'Spies of the Xanathar.', 'lore');
    const before = getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notes').get()!.n;
    const args = {
      session_path: SESSION,
      mentions: [
        { name: 'Volo', kind: 'person', match: { type: 'existing', path: NOTE_A, certain: true }, historyEntry: 'Offered the party a job.' },
      ],
      relations: [
        { from: { type: 'mention', name: 'Volo' }, relation: 'works_for', to: { type: 'existing', path: GANG } },
      ],
    };

    const readOnly = await obtainAccessToken(DEFAULT_GROUP_ID, 'notes:read');
    const denied = await result<ToolCall>(await rpc(readOnly.access, 'tools/call', { name: 'submit_wrap_up', arguments: args }));
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain('wrapup:submit');
    expect(loadPendingWrapUp(DEFAULT_GROUP_ID, 'admin', SESSION)).toBeNull();

    const full = await obtainAccessToken(DEFAULT_GROUP_ID);
    const ok = await result<ToolCall>(await rpc(full.access, 'tools/call', { name: 'submit_wrap_up', arguments: args }));
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0]!.text).toContain('Nothing has been written');
    const pending = loadPendingWrapUp(DEFAULT_GROUP_ID, 'admin', SESSION);
    expect(pending?.mentions.map((m) => m.name)).toEqual(['Volo']);
    expect(pending?.relations).toMatchObject([{ relation: 'works_for', to: { type: 'existing', path: GANG } }]);
    expect(getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM note_relations').get()!.n).toBe(0);
    expect(getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notes').get()!.n).toBe(before);
  });

  it('a world A token cannot read a world B note, and vice versa', async () => {
    const a = await obtainAccessToken(DEFAULT_GROUP_ID);
    const b = await obtainAccessToken(worldB);

    const fromA = await result<ToolCall>(await rpc(a.access, 'tools/call', { name: 'read_note', arguments: { path: NOTE_B } }));
    expect(fromA.isError).toBe(true);
    expect(fromA.content[0]!.text).toBe(`Note not found: ${NOTE_B}`);

    const fromB = await result<ToolCall>(await rpc(b.access, 'tools/call', { name: 'read_note', arguments: { path: NOTE_A } }));
    expect(fromB.isError).toBe(true);

    const browseB = await result<ToolCall>(await rpc(b.access, 'tools/call', { name: 'browse_notes', arguments: {} }));
    expect(browseB.content[0]!.text).toContain('Stranger');
    expect(browseB.content[0]!.text).not.toContain('Volo');
  });

  it('a member removed from the world loses access immediately and the grant is dropped', async () => {
    const { access, refresh, clientId } = await obtainAccessToken(worldB);
    expect((await rpc(access, 'tools/list')).status).toBe(200);

    getDb().query('DELETE FROM group_members WHERE user_id = ? AND group_id = ?').run(userId, worldB);

    expect((await rpc(access, 'tools/list')).status).toBe(401);
    const refreshed = await token(
      asNext(new Request(`${ORIGIN}/api/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }).toString(),
      })),
    );
    expect(refreshed.status).toBe(400);
    expect(((await refreshed.json()) as { error: string }).error).toBe('invalid_grant');
  });
});
