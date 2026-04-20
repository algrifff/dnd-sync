// GET /api/graph?scope=all|folder:<path>|tag:<tag>
//
// Returns the mind-map payload for the current group, optionally
// filtered to a folder or tag. ETag lets the client short-circuit
// repeat loads via If-None-Match.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { buildGraph, parseScope } from '@/lib/graph';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const payload = buildGraph(session.currentGroupId, scope);

  if (req.headers.get('if-none-match') === payload.etag) {
    return new Response(null, { status: 304, headers: { ETag: payload.etag } });
  }

  return new Response(
    JSON.stringify({
      nodes: payload.nodes,
      edges: payload.edges,
      updatedAt: payload.updatedAt,
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
