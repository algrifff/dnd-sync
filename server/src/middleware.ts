// Edge-runtime middleware. Two jobs:
//   1. Apply the security-header pack to every response.
//   2. For routes that render the web UI, require a session cookie — if
//      absent, redirect to /login with `next=<encoded path>` so the user
//      lands back where they intended after authenticating.
//
// API routes handle auth themselves (each calls requireSession or the
// legacy token gate), so they are excluded from the session check. The
// security headers still apply so every response leaves with the same
// policy.

import { NextResponse, type NextRequest } from 'next/server';
import { securityHeaders } from '@/lib/security-headers';
import { sessionCookieName } from '@/lib/session-public';

/** Paths that must NOT redirect to /login when unauthenticated. Covers
 *  the login surface itself, API routes (self-authing), static assets,
 *  Next internals, and the legacy plugin install endpoints. */
const PUBLIC_PATTERNS: readonly RegExp[] = [
  /^\/login(\/|$)/,
  /^\/api\//,
  /^\/install\//,
  /^\/_next\//,
  /^\/public\//,
  /^\/textures\//,
  /^\/fonts\//,
  /^\/favicon\.ico$/,
];

function isPublic(pathname: string): boolean {
  for (const re of PUBLIC_PATTERNS) if (re.test(pathname)) return true;
  return false;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  const headers = securityHeaders();

  if (!isPublic(pathname)) {
    const sid = req.cookies.get(sessionCookieName())?.value;
    if (!sid) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.search = '';
      url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
      const res = NextResponse.redirect(url);
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    }
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

/** Run on everything except Next's own static chunks. Security headers
 *  apply everywhere else. */
export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
