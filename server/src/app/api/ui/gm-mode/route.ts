// POST /api/ui/gm-mode — toggle the GM-mode cookie for the caller.
// Body: { on: boolean }. The cookie is a UI preference; permission
// is re-checked server-side on every request (see lib/gm-mode.ts).

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { GM_MODE_COOKIE } from '@/lib/gm-mode';

export const dynamic = 'force-dynamic';

const Body = z.object({ on: z.boolean() });

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  if (session.role !== 'admin') {
    return json({ error: 'forbidden', reason: 'GM mode is admin-only' }, 403);
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const headers = new Headers({ 'Content-Type': 'application/json' });
  // Persist for ~1 year; the path is root-scoped so every page sees it.
  // SameSite=Lax mirrors the session cookie. Not HTTP-only because the
  // pill component reads the value client-side to render its initial
  // state without a server round-trip.
  const value = parsed.on ? '1' : '0';
  const maxAge = 60 * 60 * 24 * 365;
  headers.append(
    'Set-Cookie',
    `${GM_MODE_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
  );

  return new Response(JSON.stringify({ ok: true, on: parsed.on }), {
    status: 200,
    headers,
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
