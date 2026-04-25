// GET /api/worlds/[id]/members — list all members of a world.
// Any authenticated member of the world may call this (players need the
// list to display party info; GMs use it for the character-transfer picker).

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { listUsersInGroup } from '@/lib/users';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;

  // Caller must be a member of this world.
  const membership = getDb()
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(session.userId, id);
  if (!membership) {
    return json({ error: 'forbidden' }, 403);
  }

  const members = listUsersInGroup(id);
  return json({
    members: members.map((m) => ({
      id: m.id,
      username: m.username,
      displayName: m.displayName,
      role: m.role,
    })),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
