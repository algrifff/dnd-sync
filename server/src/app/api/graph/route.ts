// GET /api/graph?scope=all|folder:<path>|tag:<tag>&phase=nodes|edges
//
// Returns the mind-map payload for the current group, optionally
// filtered to a folder or tag. ETag lets the client short-circuit
// repeat loads via If-None-Match.
//
// Optional `phase` parameter splits the payload so the client can
// render the node skeleton fast and stream edges in afterwards:
//   - omitted / "full" — full payload (legacy behaviour)
//   - "nodes" — { nodes, updatedAt }, edges omitted
//   - "edges" — { edges, updatedAt }, nodes omitted
// We still build the full payload server-side because the work is
// dominated by the SELECTs, not the JSON shaping; splitting just
// trims the wire payload and unblocks the UI sooner.

import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { buildGraph, parseScope } from '@/lib/graph';
import { GM_MODE_COOKIE, treeModeFor } from '@/lib/gm-mode';

export const dynamic = 'force-dynamic';

type Phase = 'full' | 'nodes' | 'edges';

function parsePhase(raw: string | null): Phase {
  if (raw === 'nodes' || raw === 'edges') return raw;
  return 'full';
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const phase = parsePhase(req.nextUrl.searchParams.get('phase'));
  const jar = await cookies();
  const mode = treeModeFor(jar.get(GM_MODE_COOKIE)?.value, session.role);
  const payload = buildGraph(session.currentGroupId, scope, { mode });

  // Phase-scoped ETag so the nodes-only and edges-only responses
  // don't collide in the browser's HTTP cache (304s would mix the
  // wrong shapes back to the client).
  const etag =
    phase === 'full'
      ? payload.etag
      : `${payload.etag.slice(0, -1)}-${phase}"`;

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const body: Record<string, unknown> = { updatedAt: payload.updatedAt };
  if (phase === 'full' || phase === 'nodes') body.nodes = payload.nodes;
  if (phase === 'full' || phase === 'edges') body.edges = payload.edges;

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ETag: etag,
      'Cache-Control': 'private, must-revalidate',
    },
  });
}
