import type { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { superAdminCookie, clearSuperAdminCookie } from '@/lib/superadmin';
import { adminLoginLimiter } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || 'unknown';
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export async function POST(req: NextRequest): Promise<Response> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return json({ error: 'admin not configured' }, 503);

  const ip = clientIp(req);
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const exemptRateLimit = isLocalhost && process.env.NODE_ENV !== 'production';

  const decision = adminLoginLimiter.check(ip, exemptRateLimit);
  if (!decision.allowed) {
    return json(
      { error: 'rate_limited', retryAfterMs: decision.retryAfterMs },
      429,
      { 'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)) },
    );
  }

  const body = await req.json().catch(() => null) as { token?: unknown } | null;
  const provided = typeof body?.token === 'string' ? body.token : '';

  let valid = false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    valid = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    valid = false;
  }

  if (!valid) {
    const firstLockout = adminLoginLimiter.recordFailure(ip, exemptRateLimit);
    if (firstLockout) {
      console.warn(`[admin-login] rate-limited ${ip}`);
    }
    return json({ error: 'invalid token' }, 401);
  }

  adminLoginLimiter.recordSuccess(ip);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': superAdminCookie(token),
    },
  });
}

export async function DELETE(_req: NextRequest): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSuperAdminCookie(),
    },
  });
}
