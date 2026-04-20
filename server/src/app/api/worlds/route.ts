// GET  /api/worlds  — list worlds the current user is a member of.
// POST /api/worlds  — create a new world; caller becomes its admin
//                     and their session switches into it.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { createWorld, listWorldsForSession } from '@/lib/groups';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  name: z.string().trim().min(1).max(80),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  return json({ worlds: listWorldsForSession(session.userId, session.id) });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  try {
    const id = createWorld({
      name: body.name,
      creatorUserId: session.userId,
      sessionId: session.id,
    });
    return json({ ok: true, id }, 201);
  } catch (err) {
    return json(
      { error: 'create_failed', detail: err instanceof Error ? err.message : 'err' },
      400,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
