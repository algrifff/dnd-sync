// GET  /api/worlds/[id]/invite — return the current invite token (or null).
// POST /api/worlds/[id]/invite — generate (or regenerate) an invite token.
// Both admin-only.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { createInviteToken, getInviteToken } from '@/lib/groups';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  if (!isAdmin(session.userId, id)) return json({ error: 'forbidden' }, 403);

  return json({ token: getInviteToken(id) });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  if (!isAdmin(session.userId, id)) return json({ error: 'forbidden' }, 403);

  const token = createInviteToken({ groupId: id, createdBy: session.userId });
  return json({ ok: true, token });
}

function isAdmin(userId: string, groupId: string): boolean {
  const row = getDb()
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(userId, groupId);
  return row?.role === 'admin';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
