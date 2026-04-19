// GET /api/assets/by-path?path=<vault/rel/path>
//
// Runtime fallback for image references that ingest left unresolved
// (e.g. stored PM JSON that predates a later vault re-upload, or
// markdown refs whose exact form didn't make it into the filename
// index at ingest time). Looks the path up against the current
// group's assets by full vault path first and then by basename, and
// 302-redirects to the canonical /api/assets/<id> endpoint so the
// browser picks up its caching + Range behaviour unchanged.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getAssetByVaultPath } from '@/lib/assets';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const path = req.nextUrl.searchParams.get('path');
  if (!path) return new Response('missing_path', { status: 400 });

  const asset = getAssetByVaultPath(path, session.currentGroupId);
  if (!asset) return new Response('not_found', { status: 404 });

  // 302 so the browser re-requests against the canonical cached URL.
  // Relative Location keeps the redirect on the same origin whatever
  // the deploy's base URL is.
  return new Response(null, {
    status: 302,
    headers: { Location: `/api/assets/${encodeURIComponent(asset.id)}` },
  });
}
