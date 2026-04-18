// DELETE /api/docs/<encoded-path>
//
// Removes a text doc from the server so a local delete on one client
// propagates to the SQLite row, the FTS index (via trigger), and any
// SharedDoc currently held in memory. Text docs are the only deletable
// kind here; binary deletes go through /api/files/[...path] which already
// exists.

import type { NextRequest } from 'next/server';
import { requireRequestAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { destroyDoc } from '@/ws/setup';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const { path: segments } = await ctx.params;
  const path = segments.map(decodeURIComponent).join('/');
  if (!path) {
    return Response.json(
      { code: 'invalid_path', message: 'path segment is required' },
      { status: 400 },
    );
  }

  const res = getDb().query('DELETE FROM text_docs WHERE path = ?').run(path);
  const deleted = Number(res.changes) > 0;

  // Tear down any in-memory SharedDoc so surviving peers disconnect cleanly
  // rather than keep broadcasting updates against a row that no longer exists.
  if (deleted) destroyDoc(path);

  return Response.json({ deleted });
}
