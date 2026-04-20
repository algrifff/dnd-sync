// Web-app authentication. Cookie-based sessions backed by rows in the
// `sessions` table. The session id is a 32-byte random hex string — we
// don't sign or encrypt it because a successful DB lookup IS the proof
// (constant-time lookup via the `sessions.id` PRIMARY KEY index; the
// 256-bit entropy makes guessing infeasible).
//
// Passwords are hashed with argon2id via the `@node-rs/argon2` package
// (Rust via N-API, ships prebuilts as platform-specific optional deps
// — no node-gyp compile path, installs cleanly under either Bun or
// npm). Standard PHC-format output interoperable with hashes written
// by the earlier Bun.password and `argon2` npm package code paths, so
// no migration is needed.
//
// This module coexists with the legacy token auth in `auth.ts` (plugin
// path). Neither touches the other's state.

import { randomBytes } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

// @node-rs/argon2's Algorithm enum is a `const enum`, which
// verbatimModuleSyntax refuses to import. Inline the value.
// 0 = Argon2d, 1 = Argon2i, 2 = Argon2id (upstream ordering).
const ARGON2ID = 2;
import { getDb } from './db';
import { SESSION_COOKIE as COOKIE_SID, CSRF_COOKIE as COOKIE_CSRF } from './session-public';

export { sessionCookieName, csrfCookieName } from './session-public';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LAST_SEEN_DEBOUNCE_MS = 60 * 1000; // only touch last_seen_at once a minute

export type UserRole = 'admin' | 'editor' | 'viewer';

export type CursorMode = 'color' | 'image';

export type Session = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  accentColor: string;
  currentGroupId: string;
  role: UserRole;
  csrfToken: string;
  expiresAt: number;
  cursorMode: CursorMode;
  // Monotonic counter bumped each time the avatar blob changes. Used
  // as a cache-buster when loading /api/users/:id/avatar?v=<n> and
  // also as a "has avatar?" flag (0 = no avatar uploaded).
  avatarVersion: number;
  // The user's pinned PC (null if none). Surfaced in the left
  // sidebar's active-character block; writes persist via PATCH
  // /api/profile with an activeCharacterPath field.
  activeCharacterPath: string | null;
};

export type NewSessionInput = {
  userId: string;
  groupId: string;
  userAgent?: string | null;
  ip?: string | null;
};

// ── Password helpers (argon2id) ────────────────────────────────────────

/** Hash a password. Argon2id, PHC-encoded — interchangeable with the
 *  hashes the earlier Bun.password code path produced. */
export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) throw new Error('password must be at least 8 characters');
  return argon2Hash(plain, { algorithm: ARGON2ID });
}

/** Constant-time verify a password against its stored hash. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  try {
    return await argon2Verify(hash, plain);
  } catch {
    // Malformed hash in storage. Treat as non-match; never throw from auth.
    return false;
  }
}

// ── Session id + CSRF token helpers ────────────────────────────────────

function genToken(): string {
  return randomBytes(32).toString('hex'); // 64 hex chars, 256 bits
}

// ── Cookie shape (SetCookie builder) ───────────────────────────────────

export type CookiePair = { name: string; value: string; maxAge: number };

export function buildSessionCookies(session: Session): CookiePair[] {
  const maxAgeSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  return [
    { name: COOKIE_SID, value: session.id, maxAge: maxAgeSeconds },
    { name: COOKIE_CSRF, value: session.csrfToken, maxAge: maxAgeSeconds },
  ];
}

export function buildClearSessionCookies(): CookiePair[] {
  return [
    { name: COOKIE_SID, value: '', maxAge: 0 },
    { name: COOKIE_CSRF, value: '', maxAge: 0 },
  ];
}

/** Serialize a cookie pair to a Set-Cookie header value with our
 *  security flags. `httpOnly` is false only for the CSRF cookie so the
 *  client can read it for the double-submit pattern. */
export function serialiseCookie(pair: CookiePair, opts: { httpOnly: boolean }): string {
  const parts = [
    `${pair.name}=${pair.value}`,
    `Path=/`,
    `Max-Age=${pair.maxAge}`,
    `SameSite=Lax`,
  ];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (isProduction()) parts.push('Secure');
  return parts.join('; ');
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

// ── Cookie parsing (header string → map) ───────────────────────────────

export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const seg of header.split(';')) {
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (name.length > 0) out.set(name, value);
  }
  return out;
}

// ── Session lifecycle ──────────────────────────────────────────────────

type SessionJoinRow = {
  id: string;
  user_id: string;
  current_group_id: string;
  csrf_token: string;
  expires_at: number;
  username: string;
  display_name: string;
  accent_color: string;
  role: UserRole | null;
  cursor_mode: string;
  avatar_updated_at: number;
  active_character_path: string | null;
};

/** Create a new session row and return the full Session shape, including
 *  the raw id the caller will put into the cookie. */
export function createSession(input: NewSessionInput): Session {
  const id = genToken();
  const csrf = genToken();
  const now = Date.now();
  const expiresAt = now + SESSION_LIFETIME_MS;

  getDb()
    .query(
      `INSERT INTO sessions (id, user_id, current_group_id, csrf_token,
         created_at, expires_at, last_seen_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.groupId,
      csrf,
      now,
      expiresAt,
      now,
      input.userAgent ?? null,
      input.ip ?? null,
    );

  // Touch last_login_at on the user row — best-effort, no row = caller bug.
  getDb()
    .query('UPDATE users SET last_login_at = ? WHERE id = ?')
    .run(now, input.userId);

  const enriched = loadSessionById(id);
  if (!enriched) {
    // Shouldn't be possible — we just inserted. Defensive throw.
    throw new Error('createSession: row disappeared immediately after insert');
  }
  return enriched;
}

/** Destroy an existing session (if any) and issue a fresh one. Prevents
 *  session-fixation by guaranteeing the post-login cookie is different
 *  from anything an attacker could have planted. */
export function rotateSession(oldId: string | null, input: NewSessionInput): Session {
  if (oldId) destroySession(oldId);
  return createSession(input);
}

/** Drop the row for an id. Idempotent. */
export function destroySession(id: string): void {
  if (!id) return;
  getDb().query('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Look up a session by cookie id. Expired rows are deleted on read so
 *  they don't accumulate. `touchLastSeen` can be disabled for reads that
 *  want zero DB writes (e.g. background probes). */
export function readSession(
  cookieHeader: string | null | undefined,
  touchLastSeen = true,
): Session | null {
  const cookies = parseCookies(cookieHeader);
  const id = cookies.get(COOKIE_SID);
  if (!id) return null;

  const row = loadSessionRowById(id);
  if (!row) return null;

  if (row.expires_at <= Date.now()) {
    destroySession(row.id);
    return null;
  }

  if (touchLastSeen) {
    const lastSeen =
      (getDb()
        .query<{ last_seen_at: number }, [string]>('SELECT last_seen_at FROM sessions WHERE id = ?')
        .get(row.id)?.last_seen_at) ?? 0;
    if (Date.now() - lastSeen >= LAST_SEEN_DEBOUNCE_MS) {
      getDb().query('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
    }
  }

  return shapeSession(row);
}

/** Internal helper shared by readSession + createSession paths. */
function loadSessionById(id: string): Session | null {
  const row = loadSessionRowById(id);
  if (!row) return null;
  return shapeSession(row);
}

function loadSessionRowById(id: string): SessionJoinRow | null {
  return (
    getDb()
      .query<SessionJoinRow, [string]>(
        `SELECT s.id, s.user_id, s.current_group_id, s.csrf_token, s.expires_at,
                u.username, u.display_name, u.accent_color,
                u.cursor_mode, u.avatar_updated_at,
                u.active_character_path,
                gm.role AS role
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN group_members gm
             ON gm.user_id = s.user_id AND gm.group_id = s.current_group_id
          WHERE s.id = ?`,
      )
      .get(id) ?? null
  );
}

function shapeSession(row: SessionJoinRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    accentColor: row.accent_color,
    currentGroupId: row.current_group_id,
    role: (row.role ?? 'viewer') as UserRole,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
    cursorMode: (row.cursor_mode === 'image' ? 'image' : 'color') as CursorMode,
    avatarVersion: row.avatar_updated_at,
    activeCharacterPath: row.active_character_path,
  };
}

// ── Route-handler guards ───────────────────────────────────────────────

type RequireRequest = { headers: { get(name: string): string | null } };

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: 'forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function requireSession(req: RequireRequest): Session | Response {
  const session = readSession(req.headers.get('cookie'));
  if (!session) return unauthorized();
  return session;
}

export function requireAdmin(req: RequireRequest): Session | Response {
  const session = readSession(req.headers.get('cookie'));
  if (!session) return unauthorized();
  if (session.role !== 'admin') return forbidden();
  return session;
}

// ── Maintenance ────────────────────────────────────────────────────────

/** Remove expired rows. Called once on boot; cheap. */
export function cleanupExpiredSessions(): number {
  const res = getDb().query('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  return Number(res.changes);
}

// ── WS upgrade helper (used by hocuspocus in Phase 4) ──────────────────

/** Read a session from a raw Node IncomingMessage (no NextRequest
 *  helpers available on WebSocket upgrades). Used by the hocuspocus
 *  onAuthenticate hook. */
export function readSessionFromIncoming(req: {
  headers: { cookie?: string | undefined };
}): Session | null {
  return readSession(req.headers.cookie ?? null);
}
