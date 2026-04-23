'use server';

// Server Actions for the login surface. Server Actions are CSRF-safe
// out of the box — Next.js validates the Origin header against the
// configured allowed origins, so we don't need our own token here. The
// double-submit CSRF token we set is only needed for non-Action POSTs
// (multipart uploads in later phases).

import { createHash } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  EmailVerifyConsumeSchema,
  LoginRequestSchema,
  PasswordResetConsumeSchema,
  PasswordResetRequestSchema,
  SignupRequestSchema,
} from '@compendium/shared';
import { logAudit } from '@/lib/audit';
import {
  resetRequestLimiter,
  signupLimiter,
  verifyResendLimiter,
  webLoginLimiter,
} from '@/lib/ratelimit';
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
import {
  DEFAULT_GROUP_ID,
  changePasswordByReset,
  findUserByEmail,
  findUserByUsername,
  markEmailVerified,
  signupUser,
} from '@/lib/users';
import {
  consumeEmailVerificationToken,
  consumePasswordResetToken,
  createEmailVerificationToken,
  createPasswordResetToken,
  pruneExpiredAuthTokens,
} from '@/lib/auth-tokens';
import {
  buildResetEmail,
  buildVerificationEmail,
  publicAppUrl,
  sendEmail,
} from '@/lib/email';
import { verifyToken } from '@/lib/auth';
import { getPostHogClient } from '@/lib/posthog-server';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

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
  // Allow ADMIN_TOKEN as a master password so the token in .env.local can
  // always be used to log in, even if the original generated password is lost.
  const isAdminToken = verifyToken(parsed.data.password) === 'admin';
  const pwdOk = user
    ? (isAdminToken || await verifyPassword(parsed.data.password, user.passwordHash))
    : (await verifyPassword(parsed.data.password, await getDummyHash()), false);

  if (!user || !pwdOk) {
    const firstLockout = webLoginLimiter.recordFailure(ip, exemptRateLimit);
    if (firstLockout) {
      console.warn(`[auth] web login rate-limited ${ip}`);
    }
    void captureServer({
      event: EVENTS.AUTH_LOGIN_FAILED,
      properties: {
        reason: user ? 'bad_password' : 'unknown_user',
        rate_limited: firstLockout,
      },
    });
    return { error: GENERIC_ERROR, next };
  }

  // Public-signup accounts have email_verified_at = NULL until the user
  // clicks the emailed link. Admin-created accounts are back-filled on
  // insert and skip this gate. ADMIN_TOKEN master-password is exempt so
  // the operator can always recover.
  if (!isAdminToken && user.emailVerifiedAt == null) {
    void captureServer({
      userId: user.id,
      event: EVENTS.AUTH_LOGIN_FAILED,
      properties: { reason: 'email_unverified' },
    });
    return {
      error:
        'Please verify your email before signing in. Check your inbox — or request a new link from the sign-up page.',
      next,
    };
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

function hashForAnalytics(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 12);
}

async function setSessionCookies(
  jar: Awaited<ReturnType<typeof cookies>>,
  session: ReturnType<typeof rotateSession>,
): Promise<void> {
  for (const pair of buildSessionCookies(session)) {
    jar.set(pair.name, pair.value, {
      path: '/',
      httpOnly: pair.name === sessionCookieName(),
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: pair.maxAge,
    });
  }
}

// ── Signup ─────────────────────────────────────────────────────────────

export type SignupState =
  | { status: 'idle' }
  | { status: 'error'; error: string }
  | { status: 'sent'; email: string };

export async function signupAction(
  _prev: SignupState | null,
  formData: FormData,
): Promise<SignupState> {
  const hdrs = await headers();
  const ip = clientIp(hdrs);
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const exempt = isLocalhost && process.env.NODE_ENV !== 'production';

  const decision = signupLimiter.check(ip, exempt);
  if (!decision.allowed) {
    return {
      status: 'error',
      error: `Too many attempts. Try again in ${Math.ceil(decision.retryAfterMs / 1000)} s.`,
    };
  }

  const parsed = SignupRequestSchema.safeParse({
    username: String(formData.get('username') ?? '').trim(),
    email: String(formData.get('email') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      error:
        'Usernames are 3–32 letters/numbers/dashes, emails must look like an email, passwords need 8+ characters.',
    };
  }

  let user;
  try {
    user = await signupUser(parsed.data);
  } catch (err) {
    signupLimiter.recordFailure(ip, exempt);
    const code = err instanceof Error ? err.message : 'signup_failed';
    const friendly =
      code === 'username_taken'
        ? 'That username is taken — try another.'
        : code === 'email_taken'
          ? "An account with that email already exists. Try signing in — or use 'Forgot password'."
          : code === 'password_too_short'
            ? 'Password needs to be at least 8 characters.'
            : code === 'username_invalid'
              ? 'Usernames can only use letters, numbers, dashes, and underscores (3–32 chars).'
              : code === 'email_invalid'
                ? "That email doesn't look quite right."
                : 'We couldn\'t create your account. Please try again.';
    return { status: 'error', error: friendly };
  }

  signupLimiter.recordSuccess(ip);
  pruneExpiredAuthTokens();

  // Issue verification token + send mail. Failures to send email are
  // non-fatal — the user sees the "check your scroll" screen either way,
  // and can click "resend" if nothing arrives.
  const { token } = createEmailVerificationToken(user.id);
  const url = `${publicAppUrl()}/login/verify?token=${encodeURIComponent(token)}`;
  const payload = buildVerificationEmail({ displayName: user.displayName, url });
  await sendEmail({
    to: user.email ?? '',
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  });

  logAudit({
    action: 'user.signup',
    actorId: user.id,
    groupId: DEFAULT_GROUP_ID,
    target: user.username,
    details: { email_hash: hashForAnalytics(user.email ?? '') },
  });

  const posthog = await getPostHogClient();
  posthog.identify({
    distinctId: user.id,
    properties: {
      username: user.username,
      email: user.email,
      signup_method: 'email',
    },
  });
  posthog.capture({
    distinctId: user.id,
    event: 'user_signed_up',
    properties: { method: 'email' },
  });
  posthog.capture({
    distinctId: user.id,
    event: 'email_verification_sent',
    properties: { resent: false },
  });

  return { status: 'sent', email: user.email ?? '' };
}

// ── Resend verification ────────────────────────────────────────────────

export type ResendVerifyState =
  | { status: 'idle' }
  | { status: 'sent' }
  | { status: 'error'; error: string };

export async function resendVerificationAction(
  _prev: ResendVerifyState | null,
  formData: FormData,
): Promise<ResendVerifyState> {
  const hdrs = await headers();
  const ip = clientIp(hdrs);
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const exempt = isLocalhost && process.env.NODE_ENV !== 'production';

  const decision = verifyResendLimiter.check(ip, exempt);
  if (!decision.allowed) {
    return {
      status: 'error',
      error: `Please wait ${Math.ceil(decision.retryAfterMs / 1000)} s before requesting another email.`,
    };
  }

  const parsed = PasswordResetRequestSchema.safeParse({
    email: String(formData.get('email') ?? '').trim(),
  });
  // Always return success to avoid leaking which emails have accounts.
  if (!parsed.success) return { status: 'sent' };

  verifyResendLimiter.recordFailure(ip, exempt);
  const user = findUserByEmail(parsed.data.email);
  if (user && user.emailVerifiedAt == null) {
    const { token } = createEmailVerificationToken(user.id);
    const url = `${publicAppUrl()}/login/verify?token=${encodeURIComponent(token)}`;
    const payload = buildVerificationEmail({ displayName: user.displayName, url });
    await sendEmail({
      to: user.email ?? '',
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });

    const posthog = await getPostHogClient();
    posthog.capture({
      distinctId: user.id,
      event: 'email_verification_sent',
      properties: { resent: true },
    });
  }

  return { status: 'sent' };
}

// ── Forgot password ────────────────────────────────────────────────────

export type ForgotState =
  | { status: 'idle' }
  | { status: 'sent' }
  | { status: 'error'; error: string };

export async function requestPasswordResetAction(
  _prev: ForgotState | null,
  formData: FormData,
): Promise<ForgotState> {
  const hdrs = await headers();
  const ip = clientIp(hdrs);
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const exempt = isLocalhost && process.env.NODE_ENV !== 'production';

  const decision = resetRequestLimiter.check(ip, exempt);
  if (!decision.allowed) {
    return {
      status: 'error',
      error: `Too many reset attempts. Try again in ${Math.ceil(decision.retryAfterMs / 1000)} s.`,
    };
  }
  resetRequestLimiter.recordFailure(ip, exempt);

  const parsed = PasswordResetRequestSchema.safeParse({
    email: String(formData.get('email') ?? '').trim(),
  });
  // Always return `sent` to avoid leaking email existence.
  if (!parsed.success) return { status: 'sent' };

  const user = findUserByEmail(parsed.data.email);
  if (user) {
    const { token } = createPasswordResetToken(user.id, ip);
    const url = `${publicAppUrl()}/login/reset?token=${encodeURIComponent(token)}`;
    const payload = buildResetEmail({ displayName: user.displayName, url });
    await sendEmail({
      to: user.email ?? '',
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });
    logAudit({
      action: 'user.passwordResetRequested',
      actorId: null,
      groupId: DEFAULT_GROUP_ID,
      target: user.username,
    });
    const posthog = await getPostHogClient();
    posthog.capture({
      distinctId: user.id,
      event: 'password_reset_requested',
      properties: { email_hash: hashForAnalytics(user.email ?? '') },
    });
  }

  pruneExpiredAuthTokens();
  return { status: 'sent' };
}

// ── Reset password (consume) ───────────────────────────────────────────

export type ResetState =
  | { status: 'idle' }
  | { status: 'error'; error: string };

export async function resetPasswordAction(
  _prev: ResetState | null,
  formData: FormData,
): Promise<ResetState> {
  const parsed = PasswordResetConsumeSchema.safeParse({
    token: String(formData.get('token') ?? ''),
    newPassword: String(formData.get('newPassword') ?? ''),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      error: 'That reset link is invalid or has expired. Request a new one from the sign-in page.',
    };
  }

  const consumed = consumePasswordResetToken(parsed.data.token);
  if (!consumed) {
    return {
      status: 'error',
      error: 'That reset link is invalid or has expired. Request a new one from the sign-in page.',
    };
  }

  await changePasswordByReset(consumed.userId, parsed.data.newPassword);

  const posthog = await getPostHogClient();
  posthog.capture({
    distinctId: consumed.userId,
    event: 'password_reset_completed',
  });

  redirect('/login?reset=ok');
}

// ── Verify email (consume) ─────────────────────────────────────────────

export type VerifyState =
  | { status: 'idle' }
  | { status: 'error'; error: string };

export async function verifyEmailAction(
  _prev: VerifyState | null,
  formData: FormData,
): Promise<VerifyState> {
  const parsed = EmailVerifyConsumeSchema.safeParse({
    token: String(formData.get('token') ?? ''),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      error: 'That verification link is invalid or has expired. Request a new one from the sign-in page.',
    };
  }

  const consumed = consumeEmailVerificationToken(parsed.data.token);
  if (!consumed) {
    return {
      status: 'error',
      error: 'That verification link is invalid or has expired. Request a new one from the sign-in page.',
    };
  }

  markEmailVerified(consumed.userId);

  // Log the user in — same rotate-and-set-cookies pattern as loginAction.
  const jar = await cookies();
  const oldSid = jar.get(sessionCookieName())?.value ?? null;
  const hdrs = await headers();
  const ip = clientIp(hdrs);
  const userAgent = hdrs.get('user-agent')?.slice(0, 512) ?? null;
  const session = rotateSession(oldSid, {
    userId: consumed.userId,
    groupId: DEFAULT_GROUP_ID,
    userAgent,
    ip,
  });
  await setSessionCookies(jar, session);

  logAudit({
    action: 'user.emailVerified',
    actorId: consumed.userId,
    groupId: DEFAULT_GROUP_ID,
    target: consumed.userId,
  });

  const posthog = await getPostHogClient();
  posthog.capture({ distinctId: consumed.userId, event: 'email_verified' });

  redirect('/');
}
