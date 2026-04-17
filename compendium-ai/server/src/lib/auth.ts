// Bearer-token auth. Two tokens: ADMIN_TOKEN and PLAYER_TOKEN, both pulled
// from environment. Any authenticated caller can sync / search / read+write
// files; admin-only actions (future /api/chat) gate on the returned role.

import { timingSafeEqual } from 'node:crypto';

export type Role = 'admin' | 'player';

function readEnvToken(name: 'ADMIN_TOKEN' | 'PLAYER_TOKEN'): string | null {
  const v = process.env[name];
  return v && v.length > 0 ? v : null;
}

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

/** Classifies a presented token; returns null if it matches neither role. */
export function verifyToken(token: string | null | undefined): Role | null {
  if (!token) return null;
  const admin = readEnvToken('ADMIN_TOKEN');
  const player = readEnvToken('PLAYER_TOKEN');
  if (admin && safeEqual(token, admin)) return 'admin';
  if (player && safeEqual(token, player)) return 'player';
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

/** Require both token env vars at boot. Called from server.ts. */
export function assertTokensConfigured(): void {
  const missing: string[] = [];
  if (!readEnvToken('ADMIN_TOKEN')) missing.push('ADMIN_TOKEN');
  if (!readEnvToken('PLAYER_TOKEN')) missing.push('PLAYER_TOKEN');
  if (missing.length) {
    console.error(
      `[auth] missing required env var(s): ${missing.join(', ')}. ` +
        `Set them in .env.local (dev) or the Railway service variables (prod).`,
    );
    process.exit(1);
  }
}
