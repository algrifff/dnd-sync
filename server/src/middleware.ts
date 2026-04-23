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
import { sessionCookieName, csrfCookieName } from '@/lib/session-public';

// Keep in sync with SESSION_LIFETIME_MS in session.ts. Browser-side sliding
// window: every authenticated request re-issues the SID + CSRF cookies with
// a fresh 30-day Max-Age, so the cookies persist as long as the user shows
// up at least once every 30 days. Server-side expiry slides inside
// readSession (see session.ts).
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Paths that must NOT redirect to /login when unauthenticated. Covers
 *  the login surface itself, API routes (self-authing), and static assets. */
const PUBLIC_PATTERNS: readonly RegExp[] = [
  /^\/login(\/|$)/,
  /^\/signup(\/|$)/,
  /^\/admin\/login(\/|$)/,
  /^\/api\//,
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

  // /admin/* (excluding /admin/login) is gated by the __sa super-admin cookie,
  // not a regular user session. Redirect to the admin login page if absent.
  if (/^\/admin(\/|$)/.test(pathname) && !/^\/admin\/login(\/|$)/.test(pathname)) {
    const sa = req.cookies.get('__sa')?.value;
    if (!sa) {
      const url = req.nextUrl.clone();
      url.pathname = '/admin/login';
      url.search = '';
      const res = NextResponse.redirect(url);
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    }
    const res = NextResponse.next();
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }

  const sidCookie = req.cookies.get(sessionCookieName())?.value;

  if (!isPublic(pathname)) {
    if (!sidCookie) {
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

  // Browser-side sliding session: if a SID cookie is present on a normal
  // page request, re-issue both auth cookies with a fresh 30-day Max-Age so
  // the cookies live on as long as the user keeps visiting. The actual
  // server-side expiry is refreshed inside readSession. Skip for API
  // routes (they set their own cookies on login/logout/rotate) to avoid
  // clobbering the Set-Cookie header a route handler just emitted.
  if (sidCookie && !/^\/api\//.test(pathname)) {
    const csrfCookie = req.cookies.get(csrfCookieName())?.value;
    const secure = process.env.NODE_ENV === 'production';
    res.cookies.set({
      name: sessionCookieName(),
      value: sidCookie,
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      sameSite: 'lax',
      httpOnly: true,
      secure,
    });
    if (csrfCookie) {
      res.cookies.set({
        name: csrfCookieName(),
        value: csrfCookie,
        path: '/',
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        sameSite: 'lax',
        httpOnly: false,
        secure,
      });
    }
  }

  return res;
}

/** Run on everything except Next's own static chunks. Security headers
 *  apply everywhere else. */
export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
