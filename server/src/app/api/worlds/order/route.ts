// PUT /api/worlds/order — save the caller's worlds-rail order.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { setWorldOrder } from '@/lib/groups';

export const dynamic = 'force-dynamic';

const Body = z.object({
  worldIds: z
    .array(z.string().min(1).max(64))
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate world id'),
});

export async function PUT(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const result = setWorldOrder(session.userId, body.worldIds);
  if (!result.ok) return json({ error: result.error }, 400);
  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
