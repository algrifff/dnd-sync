// GET /api/graph/neighborhood/<path...>?depth=1
//
// Subgraph of one note and its 1-hop (or 2-hop) neighbourhood. Feeds
// the MiniGraph rendered on each note page; much smaller than the
// full vault graph and re-queryable cheaply as the user navigates.

import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { decodePath } from '@/lib/notes';
import { buildNeighborhood } from '@/lib/graph';
import { GM_MODE_COOKIE, treeModeFor } from '@/lib/gm-mode';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);
  if (!path) return json({ error: 'invalid_path' }, 400);

  const depthRaw = Number(req.nextUrl.searchParams.get('depth') ?? '1');
  const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(2, Math.floor(depthRaw))) : 1;

  const jar = await cookies();
  const mode = treeModeFor(jar.get(GM_MODE_COOKIE)?.value, session.role);
  const payload = buildNeighborhood(session.currentGroupId, path, depth, { mode });
  if (!payload) return json({ error: 'not_found' }, 404);

  if (req.headers.get('if-none-match') === payload.etag) {
    return new Response(null, { status: 304, headers: { ETag: payload.etag } });
  }

  return new Response(
    JSON.stringify({
      nodes: payload.nodes,
      edges: payload.edges,
      updatedAt: payload.updatedAt,
      center: path,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ETag: payload.etag,
        'Cache-Control': 'private, must-revalidate',
      },
    },
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
