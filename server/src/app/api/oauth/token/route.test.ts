import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { POST as register } from '../register/route';
import { POST as authorize } from '../authorize/route';
import { POST as token } from './route';
import { POST as revoke } from '../revoke/route';
import { GET as asMetadata } from '@/app/.well-known/oauth-authorization-server/route';
import { GET as prMetadata } from '@/app/.well-known/oauth-protected-resource/api/mcp/route';

const ORIGIN = 'https://compendium.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let session: Session;

function asNext(req: Request): NextRequest {
  return req as unknown as NextRequest;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClaude(): Promise<string> {
  const res = await register(
    asNext(new Request(`${ORIGIN}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    })),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function consent(clientId: string, challenge: string, groupId = DEFAULT_GROUP_ID): Promise<URL> {
  const cookie = buildSessionCookies(session).map((c) => `${c.name}=${c.value}`).join('; ');
  const res = await authorize(
    asNext(new Request(`${ORIGIN}/api/oauth/authorize`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        group_id: groupId,
        query: {
          response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'xyz',
          code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/api/mcp`,
        },
      }),
    })),
  );
  expect(res.status).toBe(200);
  return new URL(((await res.json()) as { redirect: string }).redirect);
}

async function exchange(form: Record<string, string>): Promise<Response> {
  return token(
    asNext(new Request(`${ORIGIN}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })),
  );
}

beforeAll(async () => {
  setupTestDb();
  process.env.PUBLIC_APP_URL = ORIGIN;
  const user = await createUser({ username: 'claude-user', displayName: 'C', password: 'correct-horse-battery', role: 'viewer' });
  session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
});
afterAll(() => {
  delete process.env.PUBLIC_APP_URL;
  teardownTestDb();
});

describe('discovery metadata', () => {
  it('advertises the MCP resource, PKCE S256, DCR and CIMD', async () => {
    const pr = (await (await prMetadata(asNext(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`)))).json()) as Record<string, unknown>;
    const as = (await (await asMetadata(asNext(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)))).json()) as Record<string, unknown>;

    expect(pr.resource).toBe(`${ORIGIN}/api/mcp`);
    expect(pr.authorization_servers).toEqual([ORIGIN]);
    expect(as.issuer).toBe(ORIGIN);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/api/oauth/register`);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
  });
});

describe('register → authorize → token', () => {
  it('redirects back with code, state and iss after consent', async () => {
    const clientId = await registerClaude();
    const back = await consent(clientId, pkce().challenge);

    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
  });

  it('refuses consent for a world the user is not a member of', async () => {
    const clientId = await registerClaude();
    const cookie = buildSessionCookies(session).map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await authorize(
      asNext(new Request(`${ORIGIN}/api/oauth/authorize`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'approve', group_id: 'not-my-world',
          query: { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' },
        }),
      })),
    );
    expect(res.status).toBe(403);
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const clientId = await registerClaude();
    const cookie = buildSessionCookies(session).map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await authorize(
      asNext(new Request(`${ORIGIN}/api/oauth/authorize`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'approve', group_id: DEFAULT_GROUP_ID,
          query: { response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.test/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' },
        }),
      })),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('evil.test/cb?');
  });

  it('exchanges the code with the matching verifier and rotates on refresh', async () => {
    const clientId = await registerClaude();
    const { verifier, challenge } = pkce();
    const code = (await consent(clientId, challenge)).searchParams.get('code')!;

    const first = await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/api/mcp` });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const t1 = (await first.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(t1.token_type).toBe('Bearer');

    const second = await exchange({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId });
    expect(second.status).toBe(200);
    const t2 = (await second.json()) as { refresh_token: string };
    expect(t2.refresh_token).not.toBe(t1.refresh_token);

    const replay = await exchange({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a wrong verifier with invalid_grant and burns the code', async () => {
    const clientId = await registerClaude();
    const { verifier, challenge } = pkce();
    const code = (await consent(clientId, challenge)).searchParams.get('code')!;

    const bad = await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant');

    const retry = await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect(retry.status).toBe(400);
  });

  it('revoke ends the grant', async () => {
    const clientId = await registerClaude();
    const { verifier, challenge } = pkce();
    const code = (await consent(clientId, challenge)).searchParams.get('code')!;
    const t = (await (await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).json()) as { refresh_token: string };

    const res = await revoke(asNext(new Request(`${ORIGIN}/api/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.refresh_token }).toString(),
    })));
    expect(res.status).toBe(200);

    const after = await exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(after.status).toBe(400);
  });

  it('rejects registration with a non-https redirect', async () => {
    const res = await register(asNext(new Request(`${ORIGIN}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.test/cb'] }),
    })));
    expect(res.status).toBe(400);
  });
});
