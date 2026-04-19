// PATCH /api/worlds/active — switch the caller's active world. The
// server verifies membership before flipping session.current_group_id.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { setActiveWorld } from '@/lib/groups';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const Body = z.object({ id: z.string().min(1).max(64) });

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const ok = setActiveWorld(session.id, session.userId, body.id);
  if (!ok) return json({ error: 'not_a_member' }, 403);

  logAudit({
    action: 'group.switch',
    actorId: session.userId,
    groupId: body.id,
    target: body.id,
  });

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
