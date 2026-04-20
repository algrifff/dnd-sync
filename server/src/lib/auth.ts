// Bearer-token auth. Token values come from lib/config (env vars win, else
// the config table). verifyToken returns the role for admin / player tokens
// and null otherwise.

import { timingSafeEqual } from 'node:crypto';
import { getConfigValue } from './config';

export type Role = 'admin' | 'player';

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

/** Classifies a presented token; returns null if it matches none. */
export function verifyToken(token: string | null | undefined): Role | null {
  if (!token) return null;
  try {
    if (safeEqual(token, getConfigValue('admin_token'))) return 'admin';
    if (safeEqual(token, getConfigValue('player_token'))) return 'player';
  } catch {
    // config not ready — treat as unauthorized rather than crashing
  }
  return null;
}

/** Extract bearer token from an Authorization header string. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1]?.trim() ?? null;
}

/** Gate an incoming HTTP request. Returns a Response on failure, role on success. */
export function requireRequestAuth(req: Request): Role | Response {
  let token = parseBearer(req.headers.get('authorization'));
  if (!token) {
    try {
      token = new URL(req.url).searchParams.get('token');
    } catch {
      // ignore malformed URL
    }
  }
  const role = verifyToken(token);
  if (!role) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return role;
}

/** Gate on admin role specifically. Returns a 403 Response if the role is 'player'. */
export function requireAdminAuth(req: Request): Role | Response {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;
  if (auth !== 'admin') {
    return new Response(JSON.stringify({ error: 'admin only' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return auth;
}
