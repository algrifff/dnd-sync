// PATCH /api/worlds/[id] — rename a world. Admin-only.
// DELETE /api/worlds/[id] — delete a world and all its data. Admin-only;
//   refuses if it is the caller's last world.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { deleteWorld } from '@/lib/groups';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  headerColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
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
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
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

  if (body.name === undefined && body.headerColor === undefined) {
    return json({ error: 'invalid_body', detail: 'Nothing to update' }, 400);
  }

  if (body.name !== undefined) {
    db.query('UPDATE groups SET name = ? WHERE id = ?').run(body.name, id);
  }
  if (body.headerColor !== undefined) {
    db.query('UPDATE groups SET header_color = ? WHERE id = ?').run(body.headerColor, id);
  }

  logAudit({
    action: 'group.switch',
    actorId: session.userId,
    groupId: id,
    target: id,
    details: { rename: body.name, headerColor: body.headerColor },
  });

  return json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;

  try {
    const result = deleteWorld({
      groupId: id,
      actorId: session.userId,
      sessionId: session.id,
    });
    return json({ ok: true, switchToId: result.switchToId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'error';
    if (msg === 'forbidden') return json({ error: 'forbidden' }, 403);
    if (msg === 'last_world')
      return json({ error: 'last_world', detail: 'Cannot delete your only world.' }, 409);
    return json({ error: 'delete_failed', detail: msg }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
