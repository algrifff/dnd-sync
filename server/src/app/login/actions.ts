'use server';

// Server Actions for the login surface. Server Actions are CSRF-safe
// out of the box — Next.js validates the Origin header against the
// configured allowed origins, so we don't need our own token here. The
// double-submit CSRF token we set is only needed for non-Action POSTs
// (multipart uploads in later phases).

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginRequestSchema } from '@compendium/shared';
import { logAudit } from '@/lib/audit';
import { webLoginLimiter } from '@/lib/ratelimit';
import {
  buildClearSessionCookies,
  buildSessionCookies,
  destroySession,
  readSession,
  rotateSession,
  hashPassword,
  sessionCookieName,
  verifyPassword,
} from '@/lib/session';
import { DEFAULT_GROUP_ID, findUserByUsername } from '@/lib/users';
import { getPostHogClient } from '@/lib/posthog-server';

export type LoginState = { error: string | null; next: string };

const GENERIC_ERROR = 'Unknown username or password.';

// Equalises timing between "user found + wrong password" and "user
// doesn't exist" by running verifyPassword against a real hash when
// no user row was found. Lazily computed once; reused thereafter.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('never-real-user');
  return dummyHashPromise;
}

export async function loginAction(
  _prev: LoginState | null,
  formData: FormData,
): Promise<LoginState> {
  const next = toSafeNext(formData.get('next'));

  const parsed = LoginRequestSchema.safeParse({
    username: String(formData.get('username') ?? ''),
    password: String(formData.get('password') ?? ''),
  });
  if (!parsed.success) {
    return { error: 'Please enter a username and password.', next };
  }

  const hdrs = await headers();
  const ip = clientIp(hdrs);
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const exemptRateLimit = isLocalhost && process.env.NODE_ENV !== 'production';

  const decision = webLoginLimiter.check(ip, exemptRateLimit);
  if (!decision.allowed) {
    return {
      error: `Too many failed attempts. Try again in ${Math.ceil(
        decision.retryAfterMs / 1000,
      )} s.`,
      next,
    };
  }

  const user = findUserByUsername(parsed.data.username);
  const pwdOk = user
    ? await verifyPassword(parsed.data.password, user.passwordHash)
    : (await verifyPassword(parsed.data.password, await getDummyHash()), false);

  if (!user || !pwdOk) {
    const firstLockout = webLoginLimiter.recordFailure(ip, exemptRateLimit);
    if (firstLockout) {
      console.warn(`[auth] web login rate-limited ${ip}`);
    }
    return { error: GENERIC_ERROR, next };
  }

  webLoginLimiter.recordSuccess(ip);

  // Rotate — destroy any existing cookie-linked session first so this
  // login isn't riding a previously-planted cookie.
  const jar = await cookies();
  const oldSid = jar.get(sessionCookieName())?.value ?? null;
  const userAgent = hdrs.get('user-agent')?.slice(0, 512) ?? null;

  const session = rotateSession(oldSid, {
    userId: user.id,
    groupId: DEFAULT_GROUP_ID,
    userAgent,
    ip,
  });

  for (const pair of buildSessionCookies(session)) {
    jar.set(pair.name, pair.value, {
      path: '/',
      httpOnly: pair.name === sessionCookieName(),
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: pair.maxAge,
    });
  }

  logAudit({
    action: 'user.login',
    actorId: user.id,
    groupId: DEFAULT_GROUP_ID,
    target: user.username,
    details: { rotated: Boolean(oldSid) },
  });

  const posthog = await getPostHogClient();
  posthog.identify({ distinctId: user.id, properties: { username: user.username } });
  posthog.capture({ distinctId: user.id, event: 'user_logged_in', properties: { username: user.username, rotated_session: Boolean(oldSid) } });

  redirect(next);
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const sid = jar.get(sessionCookieName())?.value ?? null;

  if (sid) {
    // Best-effort audit capture before we destroy the row.
    const cookieHeader = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const session = readSession(cookieHeader, false);
    destroySession(sid);
    if (session) {
      logAudit({
        action: 'user.logout',
        actorId: session.userId,
        groupId: session.currentGroupId,
        target: session.username,
      });
      const posthog = await getPostHogClient();
      posthog.capture({ distinctId: session.userId, event: 'user_logged_out', properties: { username: session.username } });
    }
  }

  for (const pair of buildClearSessionCookies()) {
    jar.set(pair.name, pair.value, {
      path: '/',
      httpOnly: pair.name === sessionCookieName(),
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 0,
    });
  }
  redirect('/login');
}

// ── helpers ────────────────────────────────────────────────────────────

function toSafeNext(raw: FormDataEntryValue | null): string {
  const value = typeof raw === 'string' ? raw : '';
  // Only allow same-origin, root-relative paths — never redirect to an
  // external host based on a form field.
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.startsWith('/login')) return '/';
  return value;
}

function clientIp(hdrs: Headers): string {
  const fwd = hdrs.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || 'unknown';
  return hdrs.get('x-real-ip') ?? 'unknown';
}
