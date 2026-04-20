import type { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { superAdminCookie, clearSuperAdminCookie } from '@/lib/superadmin';

export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return json({ error: 'admin not configured' }, 503);

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

  if (!valid) return json({ error: 'invalid token' }, 401);

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
