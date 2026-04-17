// DELETE /api/friends/:id — revoke a friend token (soft-delete).

import type { NextRequest } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { revokeFriend } from '@/lib/friends';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const auth = requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const revoked = revokeFriend(id);
  return Response.json({ ok: true, revoked });
}
