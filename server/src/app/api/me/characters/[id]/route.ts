// GET    /api/me/characters/[id] — fetch one of the session user's characters.
// PATCH  /api/me/characters/[id] — shallow-merge update name / sheet / portrait.
// DELETE /api/me/characters/[id] — remove it (cascades bindings + bound notes).
//
// PATCH body mirrors /api/notes/sheet semantics: `sheet` is a shallow
// patch; nested objects (hit_points, ability_scores) are replaced
// wholesale. Validation runs after merge.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import {
  deleteUserCharacter,
  getUserCharacter,
  updateUserCharacter,
} from '@/lib/userCharacters';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  sheet: z.record(z.string(), z.unknown()).optional(),
  portraitUrl: z.string().max(2048).nullable().optional(),
  bodyJson: z.record(z.string(), z.unknown()).nullable().optional(),
  bodyMd: z.string().max(200_000).nullable().optional(),
});

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const character = getUserCharacter(id, session.userId);
  if (!character) return json({ error: 'not_found' }, 404);
  return json({ ok: true, character }, 200);
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;
  const { id } = await ctx.params;

  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  try {
    const character = updateUserCharacter(id, session.userId, body);
    if (!character) return json({ error: 'not_found' }, 404);
    return json({ ok: true, character }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'update failed';
    if (msg.startsWith('invalid_sheet')) {
      return json({ error: 'invalid_sheet', reason: msg }, 400);
    }
    console.error('[me/characters/:id] update failed:', err);
    return json({ error: 'update_failed', reason: msg }, 500);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;
  const { id } = await ctx.params;
  const ok = deleteUserCharacter(id, session.userId);
  if (!ok) return json({ error: 'not_found' }, 404);
  return json({ ok: true }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
