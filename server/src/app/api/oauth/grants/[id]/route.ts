// DELETE /api/oauth/grants/:id — revoke one of the caller's connected apps.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { revokeGrantForUser } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  if (!revokeGrantForUser(session.userId, id)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json({ ok: true });
}
