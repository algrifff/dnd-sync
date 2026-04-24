// PATCH /api/worlds/[id]/members/[userId] — change a member's role
// within a specific world. Admin-only. Guards against demoting the last
// admin (would_orphan_admin) and self-demotion (use /transfer first).

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { setMemberRole } from '@/lib/users';

export const dynamic = 'force-dynamic';

const Body = z.object({
  role: z.enum(['admin', 'editor', 'viewer']),
});

type Ctx = { params: Promise<{ id: string; userId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id, userId } = await ctx.params;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  // Caller must be admin of this world.
  const caller = getDb()
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(session.userId, id);
  if (!caller || caller.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }

  if (userId === session.userId) {
    return json(
      { error: 'self_demote', reason: 'Transfer world ownership first to change your own role.' },
      400,
    );
  }

  const result = setMemberRole(id, userId, body.role);
  if (!result.ok) {
    const status = result.error === 'not_member' ? 404 : 409;
    return json({ error: result.error }, status);
  }

  logAudit({
    action: 'group.member_role_changed',
    actorId: session.userId,
    groupId: id,
    target: userId,
    details: { role: body.role },
  });

  return json({ ok: true, role: body.role });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
