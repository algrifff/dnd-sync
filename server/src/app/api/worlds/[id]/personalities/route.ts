// GET  /api/worlds/[id]/personalities — list personalities + active id (admin)
// POST /api/worlds/[id]/personalities — create a new personality (admin)

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import {
  DEFAULT_PERSONALITY,
  MAX_PERSONALITY_NAME_LEN,
  MAX_PERSONALITY_PROMPT_LEN,
  createPersonality,
  listPersonalities,
} from '@/lib/ai/personalities';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const CreateBody = z.object({
  name: z.string().trim().min(1).max(MAX_PERSONALITY_NAME_LEN),
  prompt: z.string().trim().min(1).max(MAX_PERSONALITY_PROMPT_LEN),
});

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const forbid = requireAdmin(session.userId, id);
  if (forbid) return forbid;

  const db = getDb();
  const active = db
    .query<{ active_personality_id: string | null }, [string]>(
      'SELECT active_personality_id FROM groups WHERE id = ?',
    )
    .get(id);

  const items = listPersonalities(id).map((p) => ({
    id: p.id,
    name: p.name,
    prompt: p.prompt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  return json({
    activeId: active?.active_personality_id ?? DEFAULT_PERSONALITY.id,
    builtin: {
      id: DEFAULT_PERSONALITY.id,
      name: DEFAULT_PERSONALITY.name,
      prompt: DEFAULT_PERSONALITY.prompt,
    },
    items,
  });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const forbid = requireAdmin(session.userId, id);
  if (forbid) return forbid;

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
    const created = createPersonality({
      groupId: id,
      name: body.name,
      prompt: body.prompt,
      createdBy: session.userId,
    });
    logAudit({
      action: 'personality.create',
      actorId: session.userId,
      groupId: id,
      target: created.id,
      details: { name: created.name },
    });
    return json(
      {
        ok: true,
        personality: {
          id: created.id,
          name: created.name,
          prompt: created.prompt,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      },
      201,
    );
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }
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
