// GET /api/preview/<path...> — tiny payload for hover popovers and
// link cards. Returns {title, excerpt}. Cache-Control: private.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { decodePath, loadPreview } from '@/lib/notes';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);
  if (!path) return json({ error: 'invalid_path' }, 400);

  const preview = loadPreview(session.currentGroupId, path);
  if (!preview) return json({ error: 'not_found' }, 404);

  return json(preview);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=60' },
  });
}
