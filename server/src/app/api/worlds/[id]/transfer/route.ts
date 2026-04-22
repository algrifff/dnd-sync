// POST /api/worlds/[id]/transfer — transfer admin ownership to another member. Admin-only.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { transferOwnership } from '@/lib/groups';

export const dynamic = 'force-dynamic';

const Body = z.object({
  newOwnerId: z.string().min(1),
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  if (body.newOwnerId === session.userId) {
    return json({ error: 'self_transfer', reason: 'Cannot transfer to yourself.' }, 400);
  }

  const db = getDb();
  const role = db
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(session.userId, id);
  if (!role || role.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }

  try {
    transferOwnership(id, session.userId, body.newOwnerId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'error';
    if (msg === 'not_member')
      return json({ error: 'not_member', reason: 'Target user is not a member of this world.' }, 400);
    return json({ error: 'transfer_failed', reason: msg }, 500);
  }

  logAudit({
    action: 'group.transfer_ownership',
    actorId: session.userId,
    groupId: id,
    target: body.newOwnerId,
    details: { fromUserId: session.userId, toUserId: body.newOwnerId },
  });

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
