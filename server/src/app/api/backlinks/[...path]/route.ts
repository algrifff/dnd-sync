// GET /api/backlinks/<path...> — list of paths that link to this note.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { decodePath, loadBacklinks } from '@/lib/notes';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);
  if (!path) return json({ error: 'invalid_path' }, 400);

  const backlinks = loadBacklinks(session.currentGroupId, path);
  return json({ backlinks });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
