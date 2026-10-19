import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { registerClient } from '@/lib/oauth';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { POST } from './route';

const ORIGIN = 'https://compendium.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let session: Session;
let clientId: string;

function challenge(): string {
  return createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
}

function goodQuery(): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'xyz',
    code_challenge: challenge(),
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/api/mcp`,
  };
}

function authorize(
  query: Record<string, string>,
  opts: { decision?: 'approve' | 'deny'; groupId?: string; csrf?: boolean } = {},
): Promise<Response> {
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' };
  if (opts.csrf !== false) headers['x-csrf-token'] = session.csrfToken;
  return POST(
    new Request(`${ORIGIN}/api/oauth/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: opts.decision ?? 'approve',
        group_id: opts.groupId ?? DEFAULT_GROUP_ID,
        query,
      }),
    }) as unknown as NextRequest,
  );
}

function codeCount(): number {
  return getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_codes').get()!.n;
}

beforeAll(async () => {
  setupTestDb();
  process.env.PUBLIC_APP_URL = ORIGIN;
  const user = await createUser({ username: 'consenter', displayName: 'C', password: 'correct-horse-battery', role: 'viewer' });
  session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  clientId = registerClient({ clientName: 'Claude', redirectUris: [REDIRECT] }).clientId;
});
afterAll(() => {
  delete process.env.PUBLIC_APP_URL;
  teardownTestDb();
});

describe('POST /api/oauth/authorize', () => {
  it('should mint a code and redirect to the registered redirect_uri for a good request', async () => {
    const res = await authorize(goodQuery());

    const back = new URL(((await res.json()) as { redirect: string }).redirect);
    expect({ status: res.status, origin: back.origin + back.pathname, hasCode: back.searchParams.has('code') }).toEqual({
      status: 200,
      origin: REDIRECT,
      hasCode: true,
    });
  });

  it('should show an error and never redirect when the redirect_uri is not registered', async () => {
    const before = codeCount();

    const res = await authorize({ ...goodQuery(), redirect_uri: 'https://evil.test/cb' });

    const body = (await res.json()) as Record<string, unknown>;
    expect({ status: res.status, redirect: body.redirect, minted: codeCount() - before }).toEqual({
      status: 400,
      redirect: undefined,
      minted: 0,
    });
  });

  it('should refuse a look-alike of a registered redirect_uri', async () => {
    const res = await authorize({ ...goodQuery(), redirect_uri: `${REDIRECT}/../x` });

    expect(res.status).toBe(400);
  });

  it('should reject an unknown client_id without redirecting', async () => {
    const res = await authorize({ ...goodQuery(), client_id: 'no-such-client' });

    const body = (await res.json()) as Record<string, unknown>;
    expect({ status: res.status, error: body.error, redirect: body.redirect }).toEqual({
      status: 400,
      error: 'invalid_client',
      redirect: undefined,
    });
  });

  it('should redirect an invalid_target error when resource is not this MCP server', async () => {
    const before = codeCount();

    const res = await authorize({ ...goodQuery(), resource: 'https://other.test/api/mcp' });

    const back = new URL(((await res.json()) as { redirect: string }).redirect);
    expect({ error: back.searchParams.get('error'), code: back.searchParams.has('code'), minted: codeCount() - before }).toEqual({
      error: 'invalid_target',
      code: false,
      minted: 0,
    });
  });

  it('should require PKCE S256 and reject plain or a missing challenge', async () => {
    const plain = await authorize({ ...goodQuery(), code_challenge_method: 'plain' });
    const noChallenge = await authorize((({ code_challenge: _c, ...rest }) => rest)(goodQuery()));

    expect([plain.status, noChallenge.status]).toEqual([400, 400]);
  });

  it('should refuse a world the user does not belong to', async () => {
    const res = await authorize(goodQuery(), { groupId: 'not-my-world' });

    expect(res.status).toBe(403);
  });

  it('should redirect access_denied without a code when the user declines', async () => {
    const before = codeCount();

    const res = await authorize(goodQuery(), { decision: 'deny' });

    const back = new URL(((await res.json()) as { redirect: string }).redirect);
    expect({ error: back.searchParams.get('error'), minted: codeCount() - before }).toEqual({
      error: 'access_denied',
      minted: 0,
    });
  });

  it('should refuse a request without a CSRF token', async () => {
    const before = codeCount();

    const res = await authorize(goodQuery(), { csrf: false });

    expect({ status: res.status, minted: codeCount() - before }).toEqual({ status: 403, minted: 0 });
  });
});
