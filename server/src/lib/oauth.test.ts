import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { changePasswordByReset, changeUserPassword, createUser, DEFAULT_GROUP_ID } from './users';
import {
  ACCESS_TTL_MS,
  authenticateAccessToken,
  CODE_TTL_MS,
  issueCode,
  listGrantsForUser,
  pruneExpiredOauthRows,
  redeemCode,
  redirectUriAllowed,
  refreshTokens,
  registerClient,
  resolveClient,
  revokeGrantForUser,
  grantedScope,
  revokeToken,
  SCOPE,
  type OAuthClient,
} from './oauth';

const RESOURCE = 'https://compendium.test/api/mcp';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let userId: string;
let client: OAuthClient;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function grantCode(opts: { challenge: string; groupId?: string; scope?: string }): string {
  return issueCode({
    clientId: client.clientId,
    userId,
    groupId: opts.groupId ?? DEFAULT_GROUP_ID,
    redirectUri: REDIRECT,
    codeChallenge: opts.challenge,
    resource: RESOURCE,
    scope: opts.scope ?? SCOPE,
  });
}

function redeem(code: string, verifier: string) {
  return redeemCode({ code, clientId: client.clientId, redirectUri: REDIRECT, codeVerifier: verifier, resource: RESOURCE });
}

function mustRedeem(code: string, verifier: string) {
  const r = redeem(code, verifier);
  if (!r.ok) throw new Error(`redeem failed: ${r.error}`);
  return r.tokens;
}

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({ username: 'oauth-user', displayName: 'O', password: 'correct-horse-battery', role: 'editor' });
  userId = user.id;
});
afterAll(() => teardownTestDb());
beforeEach(() => {
  getDb().exec('DELETE FROM oauth_grants');
  client = registerClient({ clientName: 'Claude', redirectUris: [REDIRECT] });
});

describe('authorization code + PKCE', () => {
  it('issues tokens when the verifier matches the challenge', () => {
    const { verifier, challenge } = pkce();
    const code = grantCode({ challenge });

    const r = redeem(code, verifier);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.token_type).toBe('Bearer');
    expect(r.tokens.expires_in).toBe(ACCESS_TTL_MS / 1000);
    expect(authenticateAccessToken(r.tokens.access_token, RESOURCE)).toMatchObject({ userId, groupId: DEFAULT_GROUP_ID, role: 'editor' });
  });

  it('rejects a wrong verifier', () => {
    const code = grantCode({ challenge: pkce().challenge });

    const r = redeem(code, pkce().verifier);

    expect(r).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects a code the second time, even with the right verifier', () => {
    const { verifier, challenge } = pkce();
    const code = grantCode({ challenge });
    mustRedeem(code, verifier);

    expect(redeem(code, verifier)).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('burns a code on a failed attempt so the real client cannot redeem it afterwards', () => {
    const { verifier, challenge } = pkce();
    const code = grantCode({ challenge });
    redeem(code, 'attacker-guess');

    expect(redeem(code, verifier)).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects an expired code', () => {
    const { verifier, challenge } = pkce();
    const code = grantCode({ challenge });
    getDb().query('UPDATE oauth_codes SET expires_at = ?').run(Date.now() - 1);

    expect(redeem(code, verifier)).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects a code presented by a different client', () => {
    const { verifier, challenge } = pkce();
    const code = grantCode({ challenge });
    const other = registerClient({ clientName: 'Other', redirectUris: [REDIRECT] });

    const r = redeemCode({ code, clientId: other.clientId, redirectUri: REDIRECT, codeVerifier: verifier, resource: RESOURCE });

    expect(r).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects a code redeemed for a different resource', () => {
    const { verifier, challenge } = pkce();
    const code = grantCode({ challenge });

    const r = redeemCode({ code, clientId: client.clientId, redirectUri: REDIRECT, codeVerifier: verifier, resource: 'https://other.test/api/mcp' });

    expect(r).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it(`codes expire after ${CODE_TTL_MS / 60_000} minutes`, () => {
    const { challenge } = pkce();
    const before = Date.now();
    grantCode({ challenge });
    const row = getDb().query<{ expires_at: number }, []>('SELECT expires_at FROM oauth_codes ORDER BY created_at DESC').get()!;
    expect(row.expires_at).toBeGreaterThanOrEqual(before + CODE_TTL_MS);
  });
});

describe('access tokens', () => {
  it('rejects an expired access token', () => {
    const { verifier, challenge } = pkce();
    const tokens = mustRedeem(grantCode({ challenge }), verifier);
    getDb().query("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access'").run(Date.now() - 1);

    expect(authenticateAccessToken(tokens.access_token, RESOURCE)).toBeNull();
  });

  it('rejects an access token presented at another resource', () => {
    const { verifier, challenge } = pkce();
    const tokens = mustRedeem(grantCode({ challenge }), verifier);

    expect(authenticateAccessToken(tokens.access_token, 'https://evil.test/api/mcp')).toBeNull();
  });

  it('rejects a refresh token used as an access token', () => {
    const { verifier, challenge } = pkce();
    const tokens = mustRedeem(grantCode({ challenge }), verifier);

    expect(authenticateAccessToken(tokens.refresh_token, RESOURCE)).toBeNull();
  });

  it('cuts off a user removed from the world and drops the grant', () => {
    const { verifier, challenge } = pkce();
    const tokens = mustRedeem(grantCode({ challenge }), verifier);
    getDb().query('DELETE FROM group_members WHERE user_id = ? AND group_id = ?').run(userId, DEFAULT_GROUP_ID);
    try {
      expect(authenticateAccessToken(tokens.access_token, RESOURCE)).toBeNull();
      expect(listGrantsForUser(userId)).toHaveLength(0);
    } finally {
      getDb().query("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)").run(DEFAULT_GROUP_ID, userId, Date.now());
    }
  });

  it('reports the current role, not the role at consent time', () => {
    const { verifier, challenge } = pkce();
    const tokens = mustRedeem(grantCode({ challenge }), verifier);
    getDb().query("UPDATE group_members SET role = 'viewer' WHERE user_id = ?").run(userId);
    try {
      expect(authenticateAccessToken(tokens.access_token, RESOURCE)?.role).toBe('viewer');
    } finally {
      getDb().query("UPDATE group_members SET role = 'editor' WHERE user_id = ?").run(userId);
    }
  });
});

describe('refresh rotation', () => {
  it('issues a new pair and invalidates the old refresh token', () => {
    const { verifier, challenge } = pkce();
    const first = mustRedeem(grantCode({ challenge }), verifier);

    const second = refreshTokens({ refreshToken: first.refresh_token, clientId: client.clientId });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.tokens.refresh_token).not.toBe(first.refresh_token);
    expect(authenticateAccessToken(second.tokens.access_token, RESOURCE)).not.toBeNull();
    expect(refreshTokens({ refreshToken: first.refresh_token, clientId: client.clientId })).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects a refresh from a different client', () => {
    const { verifier, challenge } = pkce();
    const first = mustRedeem(grantCode({ challenge }), verifier);
    const other = registerClient({ clientName: 'Other', redirectUris: [REDIRECT] });

    expect(refreshTokens({ refreshToken: first.refresh_token, clientId: other.clientId })).toMatchObject({ ok: false, error: 'invalid_grant' });
  });
});

describe('scopes', () => {
  it('grants every scope when the request names none, and only known ones otherwise', () => {
    expect(grantedScope(undefined)).toBe('notes:read wrapup:submit');
    expect(grantedScope('')).toBe('notes:read wrapup:submit');
    expect(grantedScope('admin:everything')).toBe('notes:read wrapup:submit');
    expect(grantedScope('notes:read')).toBe('notes:read');
    expect(grantedScope('wrapup:submit')).toBe('notes:read wrapup:submit');
  });

  it('carries the granted scope to the token response, the principal and a refreshed token', () => {
    const { verifier, challenge } = pkce();
    const first = mustRedeem(grantCode({ challenge, scope: 'notes:read' }), verifier);

    expect(first.scope).toBe('notes:read');
    expect(authenticateAccessToken(first.access_token, RESOURCE)?.scopes).toEqual(['notes:read']);

    const second = refreshTokens({ refreshToken: first.refresh_token, clientId: client.clientId });
    if (!second.ok) throw new Error('refresh failed');
    expect(second.tokens.scope).toBe('notes:read');
    expect(authenticateAccessToken(second.tokens.access_token, RESOURCE)?.scopes).toEqual(['notes:read']);
  });
});

describe('reuse detection', () => {
  const ageSpent = (ms: number) => getDb().query('UPDATE oauth_spent SET spent_at = spent_at - ?').run(ms);

  it('revokes the grant when an authorization code is replayed after a successful exchange', () => {
    const { verifier, challenge } = pkce();
    const code = grantCode({ challenge });
    const tokens = mustRedeem(code, verifier);

    expect(redeem(code, verifier)).toMatchObject({ ok: false, error: 'invalid_grant' });

    expect(authenticateAccessToken(tokens.access_token, RESOURCE)).toBeNull();
    expect(refreshTokens({ refreshToken: tokens.refresh_token, clientId: client.clientId })).toMatchObject({ ok: false });
  });

  it('revokes the grant when a rotated refresh token is replayed after the grace window', () => {
    const { verifier, challenge } = pkce();
    const first = mustRedeem(grantCode({ challenge }), verifier);
    const second = refreshTokens({ refreshToken: first.refresh_token, clientId: client.clientId });
    if (!second.ok) throw new Error('refresh failed');
    ageSpent(11_000);

    expect(refreshTokens({ refreshToken: first.refresh_token, clientId: client.clientId })).toMatchObject({ ok: false });

    expect(authenticateAccessToken(second.tokens.access_token, RESOURCE)).toBeNull();
    expect(refreshTokens({ refreshToken: second.tokens.refresh_token, clientId: client.clientId })).toMatchObject({ ok: false });
  });

  it('leaves the grant alone when a rotated token is retried within the grace window', () => {
    const { verifier, challenge } = pkce();
    const first = mustRedeem(grantCode({ challenge }), verifier);
    const second = refreshTokens({ refreshToken: first.refresh_token, clientId: client.clientId });
    if (!second.ok) throw new Error('refresh failed');

    expect(refreshTokens({ refreshToken: first.refresh_token, clientId: client.clientId })).toMatchObject({ ok: false });

    expect(authenticateAccessToken(second.tokens.access_token, RESOURCE)).not.toBeNull();
  });
});

describe('password changes', () => {
  const connect = () => {
    const { verifier, challenge } = pkce();
    return mustRedeem(grantCode({ challenge }), verifier);
  };

  it('a forgot-password reset revokes connected apps', async () => {
    const tokens = connect();

    await changePasswordByReset(userId, 'a-brand-new-password');

    expect(authenticateAccessToken(tokens.access_token, RESOURCE)).toBeNull();
    expect(listGrantsForUser(userId)).toHaveLength(0);
  });

  it('an admin password change revokes connected apps', async () => {
    const tokens = connect();

    await changeUserPassword(userId, 'another-new-password', userId, DEFAULT_GROUP_ID);

    expect(authenticateAccessToken(tokens.access_token, RESOURCE)).toBeNull();
  });
});

describe('revocation', () => {
  it('RFC 7009 revoke on either token ends the grant', () => {
    const { verifier, challenge } = pkce();
    const tokens = mustRedeem(grantCode({ challenge }), verifier);

    revokeToken(tokens.refresh_token);

    expect(authenticateAccessToken(tokens.access_token, RESOURCE)).toBeNull();
  });

  it('a user can revoke their own grant but not someone else’s', async () => {
    const { verifier, challenge } = pkce();
    const tokens = mustRedeem(grantCode({ challenge }), verifier);
    const [grant] = listGrantsForUser(userId);
    const other = await createUser({ username: 'other-user', displayName: 'X', password: 'correct-horse-battery', role: 'viewer' });

    expect(revokeGrantForUser(other.id, grant!.id)).toBe(false);
    expect(authenticateAccessToken(tokens.access_token, RESOURCE)).not.toBeNull();
    expect(revokeGrantForUser(userId, grant!.id)).toBe(true);
    expect(authenticateAccessToken(tokens.access_token, RESOURCE)).toBeNull();
  });
});

describe('pruning', () => {
  it('drops a grant once its last token has expired, and a day-old DCR client that never reached consent', () => {
    const { verifier, challenge } = pkce();
    mustRedeem(grantCode({ challenge }), verifier);
    const live = listGrantsForUser(userId);
    expect(live).toHaveLength(1);
    const stale = registerClient({ clientName: 'abandoned', redirectUris: [REDIRECT] });
    getDb().query("UPDATE oauth_clients SET created_at = ? WHERE client_id = ?").run(Date.now() - 2 * 24 * 60 * 60_000, stale.clientId);

    pruneExpiredOauthRows();
    expect(listGrantsForUser(userId)).toHaveLength(1);
    expect(getDb().query('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(stale.clientId)).toBeFalsy();
    expect(getDb().query('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(client.clientId)).toBeTruthy();

    getDb().query('UPDATE oauth_tokens SET expires_at = ?').run(Date.now() - 1);
    pruneExpiredOauthRows();
    expect(listGrantsForUser(userId)).toHaveLength(0);
  });
});

describe('pruning CIMD clients', () => {
  const insertCimd = (id: string, fetchedAt: number) =>
    getDb()
      .query("INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris_json, created_at, fetched_at) VALUES (?, 'cimd', 'Claude', ?, ?, ?)")
      .run(id, JSON.stringify([REDIRECT]), fetchedAt, fetchedAt);
  const exists = (id: string) => !!getDb().query('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(id);

  it('drops a CIMD client unused for 30 days but keeps a recent one and one with a grant', () => {
    const old = Date.now() - 31 * 24 * 60 * 60_000;
    insertCimd('https://old.test/unused', old);
    insertCimd('https://fresh.test/used', Date.now() - 24 * 60 * 60_000);
    insertCimd('https://old.test/has-grant', old);
    getDb()
      .query("INSERT INTO oauth_grants (id, client_id, user_id, group_id, resource, scope, created_at, last_used_at) VALUES ('g-cimd', 'https://old.test/has-grant', ?, ?, ?, 'notes:read', ?, ?)")
      .run(userId, DEFAULT_GROUP_ID, RESOURCE, old, old);
    getDb()
      .query("INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES ('h-cimd', 'g-cimd', 'refresh', ?, ?)")
      .run(old, Date.now() + 60_000);

    pruneExpiredOauthRows();

    expect(exists('https://old.test/unused')).toBe(false);
    expect(exists('https://fresh.test/used')).toBe(true);
    expect(exists('https://old.test/has-grant')).toBe(true);
  });
});

describe('clients', () => {
  it('matches loopback redirect URIs with the port ignored', () => {
    const c: OAuthClient = { clientId: 'x', kind: 'dcr', clientName: 'Claude Code', redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'] };
    expect(redirectUriAllowed(c, 'http://localhost:3118/callback')).toBe(true);
    expect(redirectUriAllowed(c, 'http://127.0.0.1:5000/callback')).toBe(true);
    expect(redirectUriAllowed(c, 'http://localhost:3118/other')).toBe(false);
    expect(redirectUriAllowed(c, 'https://evil.test/callback')).toBe(false);
  });

  it('does not loosen matching for non-loopback hosts', () => {
    expect(redirectUriAllowed(client, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false);
  });

  it('resolves a Client ID Metadata Document and rejects a mismatched client_id', async () => {
    const id = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    const doc = { client_id: id, client_name: 'Claude', redirect_uris: [REDIRECT] };
    const fetcher = async () => Response.json(doc);

    const resolved = await resolveClient(id, fetcher);
    expect(resolved).toMatchObject({ kind: 'cimd', clientName: 'Claude', redirectUris: [REDIRECT] });

    const bad = await resolveClient('https://evil.test/claude.json', async () => Response.json(doc));
    expect(bad).toBeNull();
  });

  it('serves a cached CIMD client without refetching', async () => {
    const id = 'https://claude.ai/oauth/cached-client';
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return Response.json({ client_id: id, client_name: 'Claude', redirect_uris: [REDIRECT] });
    };
    await resolveClient(id, fetcher);
    await resolveClient(id, fetcher);
    expect(calls).toBe(1);
  });

  it('rejects a CIMD document bigger than 64 KB', async () => {
    const id = 'https://claude.ai/oauth/huge-client';
    const doc = { client_id: id, client_name: 'Claude', redirect_uris: [REDIRECT], padding: 'x'.repeat(70_000) };
    expect(await resolveClient(id, async () => Response.json(doc))).toBeNull();
  });

  it('stops reading a streamed CIMD body once it passes 64 KB', async () => {
    const id = 'https://claude.ai/oauth/endless-client';
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16_384).fill(0x20));
      },
    });
    expect(await resolveClient(id, async () => new Response(body))).toBeNull();
    expect(pulled).toBeLessThan(10);
  });

  it('does not refetch a failing CIMD url within the minute', async () => {
    const id = 'https://claude.ai/oauth/flaky-client';
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response('nope', { status: 500 });
    };
    expect(await resolveClient(id, fetcher)).toBeNull();
    expect(await resolveClient(id, fetcher)).toBeNull();
    expect(calls).toBe(1);
  });

  it('does not resolve a plain-http or path-less client_id as CIMD', async () => {
    expect(await resolveClient('http://claude.ai/x', async () => Response.json({}))).toBeNull();
    expect(await resolveClient('https://claude.ai', async () => Response.json({}))).toBeNull();
  });
});
