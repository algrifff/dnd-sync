// PATCH  /api/worlds/[id]/personalities/[pid] — rename / edit prompt (admin)
// DELETE /api/worlds/[id]/personalities/[pid] — delete (admin)

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import {
  MAX_PERSONALITY_NAME_LEN,
  MAX_PERSONALITY_PROMPT_LEN,
  deletePersonality,
  updatePersonality,
} from '@/lib/ai/personalities';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; pid: string }> };

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(MAX_PERSONALITY_NAME_LEN).optional(),
    prompt: z.string().trim().min(1).max(MAX_PERSONALITY_PROMPT_LEN).optional(),
  })
  .refine((v) => v.name !== undefined || v.prompt !== undefined, {
    message: 'Nothing to update',
  });

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id, pid } = await ctx.params;
  const forbid = requireAdmin(session.userId, id);
  if (forbid) return forbid;

  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  try {
    const updated = updatePersonality({
      groupId: id,
      id: pid,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
    });
    if (!updated) return json({ error: 'not_found' }, 404);
    logAudit({
      action: 'personality.update',
      actorId: session.userId,
      groupId: id,
      target: pid,
      details: {
        renamed: body.name !== undefined,
        prompt_changed: body.prompt !== undefined,
      },
    });
    return json({
      ok: true,
      personality: {
        id: updated.id,
        name: updated.name,
        prompt: updated.prompt,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id, pid } = await ctx.params;
  const forbid = requireAdmin(session.userId, id);
  if (forbid) return forbid;

  const removed = deletePersonality(id, pid);
  if (!removed) return json({ error: 'not_found' }, 404);

  logAudit({
    action: 'personality.delete',
    actorId: session.userId,
    groupId: id,
    target: pid,
    details: {},
  });
  return json({ ok: true });
}

function requireAdmin(userId: string, groupId: string): Response | null {
  const row = getDb()
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(userId, groupId);
  if (!row || row.role !== 'admin') return json({ error: 'forbidden' }, 403);
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
