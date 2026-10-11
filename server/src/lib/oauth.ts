// OAuth 2.1 authorization server for the MCP connector. Compendium is
// both the authorization server and the resource server: a user signs
// in with the normal session, consents to one world, and Claude gets a
// bearer token bound to (user, world, resource).
//
// The aggregate is the grant. Codes become grants; access and refresh
// tokens hang off a grant and die with it. Nothing here stores a
// secret in the clear: codes and tokens are SHA-256 hashed on write
// and looked up by hash.
//
// Client identity comes in two shapes, both rows in oauth_clients:
//   - 'dcr'  — RFC 7591 registration, random client_id.
//   - 'cimd' — Client ID Metadata Document. The client_id IS an HTTPS
//              URL; the row caches the fetched document.
// Claude prefers CIMD when the server advertises it and falls back to
// DCR, so both are supported.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db';
import { createGuardedFetch } from './ssrf';
import type { UserRole } from './session';

export const SCOPE = 'notes:read';
export const CODE_TTL_MS = 5 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const CIMD_CACHE_MS = 60 * 60_000;
const CIMD_FETCH_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_FAILURE_TTL_MS = 60_000;
// A rotated refresh token presented again within this window is treated as
// a client retry (lost response, parallel refresh), not as theft.
const REUSE_GRACE_MS = 10_000;
const CIMD_UNUSED_MS = 30 * 24 * 60 * 60_000;

// Recently failed CIMD urls, so the authorize page cannot be used to make
// the server hammer an arbitrary host. Bounded by the sweep below.
const cimdFailures = new Map<string, number>();

function recentlyFailed(url: string, now: number): boolean {
  const at = cimdFailures.get(url);
  if (at === undefined) return false;
  if (now - at < CIMD_FAILURE_TTL_MS) return true;
  cimdFailures.delete(url);
  return false;
}

function noteFailure(url: string, now: number): void {
  if (cimdFailures.size >= 1000) {
    for (const [u, at] of cimdFailures) if (now - at >= CIMD_FAILURE_TTL_MS) cimdFailures.delete(u);
    if (cimdFailures.size >= 1000) cimdFailures.clear();
  }
  cimdFailures.set(url, now);
}

async function readCappedJson(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('empty body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CIMD_MAX_BYTES) {
      await reader.cancel();
      throw new Error('client metadata document too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export type OAuthClient = {
  clientId: string;
  kind: 'dcr' | 'cimd';
  clientName: string;
  redirectUris: string[];
};

export type TokenSet = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type';

export type TokenResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; error: OAuthErrorCode; description: string };

export type TokenPrincipal = {
  grantId: string;
  userId: string;
  groupId: string;
  role: UserRole;
};

export type GrantSummary = {
  id: string;
  clientName: string;
  worldName: string;
  createdAt: number;
  lastUsedAt: number;
};

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function secret(): string {
  return randomBytes(32).toString('base64url');
}

// ── Redirect URIs ──────────────────────────────────────────────────────

/** OAuth 2.1 §1.5: HTTPS, or plain http on a loopback address. */
export function isAcceptableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Exact match, except that loopback redirects (Claude Code picks an
 *  ephemeral port per session, RFC 8252 §7.3) match with the port
 *  ignored. */
export function redirectUriAllowed(client: OAuthClient, presented: string): boolean {
  if (client.redirectUris.includes(presented)) return true;
  let p: URL;
  try {
    p = new URL(presented);
  } catch {
    return false;
  }
  if (p.protocol !== 'http:' || !isLoopbackHost(p.hostname)) return false;
  return client.redirectUris.some((r) => {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      return false;
    }
    return (
      u.protocol === 'http:' &&
      isLoopbackHost(u.hostname) &&
      u.hostname === p.hostname &&
      u.pathname === p.pathname &&
      u.search === p.search
    );
  });
}

// ── Clients ────────────────────────────────────────────────────────────

type ClientRow = {
  client_id: string;
  kind: 'dcr' | 'cimd';
  client_name: string;
  redirect_uris_json: string;
  fetched_at: number;
};

function rowToClient(r: ClientRow): OAuthClient {
  return {
    clientId: r.client_id,
    kind: r.kind,
    clientName: r.client_name,
    redirectUris: JSON.parse(r.redirect_uris_json) as string[],
  };
}

function loadClientRow(clientId: string): ClientRow | null {
  return (
    getDb()
      .query<ClientRow, [string]>(
        'SELECT client_id, kind, client_name, redirect_uris_json, fetched_at FROM oauth_clients WHERE client_id = ?',
      )
      .get(clientId) ?? null
  );
}

function upsertClient(c: OAuthClient, now: number): void {
  getDb()
    .query(
      `INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris_json, created_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         client_name = excluded.client_name,
         redirect_uris_json = excluded.redirect_uris_json,
         fetched_at = excluded.fetched_at`,
    )
    .run(c.clientId, c.kind, c.clientName, JSON.stringify(c.redirectUris), now, now);
}

/** RFC 7591 registration. The caller has already validated the body. */
export function registerClient(input: { clientName: string; redirectUris: string[] }): OAuthClient {
  const client: OAuthClient = {
    clientId: randomUUID(),
    kind: 'dcr',
    clientName: input.clientName,
    redirectUris: input.redirectUris,
  };
  upsertClient(client, Date.now());
  return client;
}

const CimdDocument = z.object({
  client_id: z.string(),
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string()).min(1).max(20),
});

/** A CIMD client_id is an HTTPS URL with a path and no fragment. */
export function isCimdClientId(clientId: string): boolean {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.pathname.length > 1 && !u.hash;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Production fetches refuse hosts that resolve to non-public addresses.
const defaultFetcher: Fetcher = createGuardedFetch();

/** Resolve a client_id to a client: a DCR row, or a CIMD document
 *  fetched (and cached for an hour) from the client_id URL. Null when
 *  unknown, unreachable or malformed. */
export async function resolveClient(
  clientId: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<OAuthClient | null> {
  const row = loadClientRow(clientId);
  const now = Date.now();
  if (row && (row.kind === 'dcr' || now - row.fetched_at < CIMD_CACHE_MS)) return rowToClient(row);
  if (!isCimdClientId(clientId)) return null;
  if (recentlyFailed(clientId, now)) return row ? rowToClient(row) : null;

  try {
    const res = await fetcher(clientId, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const doc = CimdDocument.parse(await readCappedJson(res));
    if (doc.client_id !== clientId) return null;
    if (!doc.redirect_uris.every(isAcceptableRedirectUri)) return null;
    const client: OAuthClient = {
      clientId,
      kind: 'cimd',
      clientName: doc.client_name,
      redirectUris: doc.redirect_uris,
    };
    upsertClient(client, now);
    return client;
  } catch (err) {
    noteFailure(clientId, now);
    console.error('[oauth] cimd fetch failed', clientId, err instanceof Error ? err.message : err);
    return row ? rowToClient(row) : null;
  }
}

// ── Authorization codes ────────────────────────────────────────────────

export type CodeInput = {
  clientId: string;
  userId: string;
  groupId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
};

export function issueCode(input: CodeInput): string {
  const code = secret();
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, group_id, redirect_uri,
         code_challenge, resource, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sha256(code),
      input.clientId,
      input.userId,
      input.groupId,
      input.redirectUri,
      input.codeChallenge,
      input.resource,
      SCOPE,
      now,
      now + CODE_TTL_MS,
    );
  return code;
}

type CodeRow = {
  code_hash: string;
  client_id: string;
  user_id: string;
  group_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  expires_at: number;
};

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export type RedeemInput = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string | null;
};

/** Exchange a code for tokens. The code row is deleted on the first
 *  attempt whatever the outcome, so a stolen code that loses the race
 *  cannot be replayed. */
export function redeemCode(input: RedeemInput): TokenResult {
  const db = getDb();
  const row = db
    .query<CodeRow, [string]>(
      `SELECT code_hash, client_id, user_id, group_id, redirect_uri, code_challenge, resource, expires_at
         FROM oauth_codes WHERE code_hash = ?`,
    )
    .get(sha256(input.code));
  if (!row) {
    const spent = loadSpent(input.code, 'code');
    if (spent) revokeGrantById(spent.grant_id);
    return fail('invalid_grant', 'unknown or already used code');
  }
  db.query('DELETE FROM oauth_codes WHERE code_hash = ?').run(row.code_hash);

  if (row.expires_at <= Date.now()) return fail('invalid_grant', 'code expired');
  if (row.client_id !== input.clientId) return fail('invalid_grant', 'code was issued to another client');
  if (row.redirect_uri !== input.redirectUri) return fail('invalid_grant', 'redirect_uri mismatch');
  if (input.resource !== null && input.resource !== row.resource) {
    return fail('invalid_grant', 'resource mismatch');
  }
  if (pkceChallenge(input.codeVerifier) !== row.code_challenge) {
    return fail('invalid_grant', 'PKCE verification failed');
  }
  if (!memberRole(row.user_id, row.group_id)) return fail('invalid_grant', 'no longer a member of that world');

  const now = Date.now();
  const grantId = randomUUID();
  db.query(
    `INSERT INTO oauth_grants (id, client_id, user_id, group_id, resource, scope, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(grantId, row.client_id, row.user_id, row.group_id, row.resource, SCOPE, now, now);
  recordSpent(row.code_hash, grantId, 'code', now);
  return { ok: true, tokens: mintTokens(grantId, now) };
}

type SpentRow = { grant_id: string; spent_at: number };

function loadSpent(secretValue: string, kind: 'code' | 'refresh'): SpentRow | null {
  return (
    getDb()
      .query<SpentRow, [string, string]>('SELECT grant_id, spent_at FROM oauth_spent WHERE token_hash = ? AND kind = ?')
      .get(sha256(secretValue), kind) ?? null
  );
}

function recordSpent(hash: string, grantId: string, kind: 'code' | 'refresh', now: number): void {
  getDb()
    .query('INSERT OR IGNORE INTO oauth_spent (token_hash, grant_id, kind, spent_at) VALUES (?, ?, ?, ?)')
    .run(hash, grantId, kind, now);
}

function fail(error: OAuthErrorCode, description: string): TokenResult {
  return { ok: false, error, description };
}

function mintTokens(grantId: string, now: number): TokenSet {
  const access = secret();
  const refresh = secret();
  const insert = getDb().query(
    'INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(sha256(access), grantId, 'access', now, now + ACCESS_TTL_MS);
  insert.run(sha256(refresh), grantId, 'refresh', now, now + REFRESH_TTL_MS);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: SCOPE,
  };
}

// ── Refresh ────────────────────────────────────────────────────────────

type TokenRow = {
  token_hash: string;
  grant_id: string;
  kind: 'access' | 'refresh';
  expires_at: number;
  client_id: string;
  user_id: string;
  group_id: string;
  resource: string;
};

function loadToken(token: string): TokenRow | null {
  return (
    getDb()
      .query<TokenRow, [string]>(
        `SELECT t.token_hash, t.grant_id, t.kind, t.expires_at,
                g.client_id, g.user_id, g.group_id, g.resource
           FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
          WHERE t.token_hash = ?`,
      )
      .get(sha256(token)) ?? null
  );
}

/** Rotate a refresh token: the presented one is deleted and a fresh
 *  pair is issued. Reuse of an already-rotated token is invalid_grant,
 *  which is what Claude expects before it re-prompts the user. */
export function refreshTokens(input: { refreshToken: string; clientId: string }): TokenResult {
  const row = loadToken(input.refreshToken);
  if (!row || row.kind !== 'refresh') {
    const spent = row ? null : loadSpent(input.refreshToken, 'refresh');
    if (spent && Date.now() - spent.spent_at > REUSE_GRACE_MS) revokeGrantById(spent.grant_id);
    return fail('invalid_grant', 'unknown refresh token');
  }
  const db = getDb();
  db.query('DELETE FROM oauth_tokens WHERE token_hash = ?').run(row.token_hash);
  recordSpent(row.token_hash, row.grant_id, 'refresh', Date.now());
  if (row.expires_at <= Date.now()) return fail('invalid_grant', 'refresh token expired');
  if (row.client_id !== input.clientId) return fail('invalid_grant', 'token was issued to another client');
  if (!memberRole(row.user_id, row.group_id)) {
    revokeGrantById(row.grant_id);
    return fail('invalid_grant', 'no longer a member of that world');
  }
  const now = Date.now();
  db.query('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(now, row.grant_id);
  return { ok: true, tokens: mintTokens(row.grant_id, now) };
}

// ── Resource-server side ───────────────────────────────────────────────

function memberRole(userId: string, groupId: string): UserRole | null {
  return (
    getDb()
      .query<{ role: UserRole }, [string, string]>(
        'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
      )
      .get(userId, groupId)?.role ?? null
  );
}

/** Validate a bearer token for `resource`. The role is read from
 *  group_members on every call, so removing a member cuts them off
 *  immediately and drops the grant. */
export function authenticateAccessToken(token: string, resource: string): TokenPrincipal | null {
  const row = loadToken(token);
  if (!row || row.kind !== 'access') return null;
  if (row.expires_at <= Date.now()) return null;
  if (row.resource !== resource) return null;
  const role = memberRole(row.user_id, row.group_id);
  if (!role) {
    revokeGrantById(row.grant_id);
    return null;
  }
  getDb().query('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(Date.now(), row.grant_id);
  return { grantId: row.grant_id, userId: row.user_id, groupId: row.group_id, role };
}

// ── Revocation + listing ───────────────────────────────────────────────

function revokeGrantById(grantId: string): void {
  getDb().query('DELETE FROM oauth_grants WHERE id = ?').run(grantId);
}

/** RFC 7009: revoking either token kind ends the whole grant. Unknown
 *  tokens are a silent success, as the RFC requires. */
export function revokeToken(token: string): void {
  const row = loadToken(token);
  if (row) revokeGrantById(row.grant_id);
}

export function listGrantsForUser(userId: string): GrantSummary[] {
  return getDb()
    .query<
      { id: string; client_name: string; world_name: string; created_at: number; last_used_at: number },
      [string]
    >(
      `SELECT g.id, c.client_name, w.name AS world_name, g.created_at, g.last_used_at
         FROM oauth_grants g
         JOIN oauth_clients c ON c.client_id = g.client_id
         JOIN groups w ON w.id = g.group_id
        WHERE g.user_id = ?
        ORDER BY g.created_at DESC`,
    )
    .all(userId)
    .map((r) => ({
      id: r.id,
      clientName: r.client_name,
      worldName: r.world_name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
}

/** Revoke one of the caller's own grants. False when it isn't theirs. */
export function revokeGrantForUser(userId: string, grantId: string): boolean {
  const res = getDb()
    .query('DELETE FROM oauth_grants WHERE id = ? AND user_id = ?')
    .run(grantId, userId);
  return Number(res.changes) > 0;
}

const STALE_CLIENT_MS = 24 * 60 * 60_000;

/** Drop expired codes and tokens, then what they leave behind: a grant
 *  whose last refresh token expired can never be used again, so it
 *  leaves the Connected apps list; and a DCR client that never reached
 *  consent (Claude registers afresh on every connection attempt) is
 *  dropped after a day. Called from boot and hourly. */
export function pruneExpiredOauthRows(): void {
  const now = Date.now();
  const db = getDb();
  db.query('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now);
  db.query('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now);
  db.query('DELETE FROM oauth_spent WHERE spent_at <= ?').run(now - REFRESH_TTL_MS);
  db.query(
    'DELETE FROM oauth_grants WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id)',
  ).run();
  db.query(
    `DELETE FROM oauth_clients
      WHERE ((kind = 'dcr' AND created_at <= ?) OR (kind = 'cimd' AND fetched_at <= ?))
        AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)
        AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.client_id)`,
  ).run(now - STALE_CLIENT_MS, now - CIMD_UNUSED_MS);
}
