// GET /api/ui/search?q=<query> — quick-find scoped to the caller's active world.
// Session-authenticated (used by the header search bar).

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { searchWorld, type UiSearchResult } from '@/lib/search';
import { GM_MODE_COOKIE, isGmModeOn } from '@/lib/gm-mode';

export const dynamic = 'force-dynamic';

export type { UiSearchResult };
export type UiSearchResponse = { query: string; results: UiSearchResult[] };

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (!q) {
    return Response.json({ query: '', results: [] } satisfies UiSearchResponse);
  }

  // GM-mode searches only the GM namespace; everything else searches
  // the player namespace. Non-admins never see gm_only rows even if
  // they fake the cookie because isGmModeOn requires role=admin.
  const gmMode = isGmModeOn(req.cookies.get(GM_MODE_COOKIE)?.value, session.role);

  try {
    const results = searchWorld({ q, groupId: session.currentGroupId, role: session.role, gmMode });
    return Response.json({ query: q, results } satisfies UiSearchResponse);
  } catch (err) {
    console.error('[ui-search] query failed', err);
    return Response.json({ error: 'search_failed' }, { status: 500 });
  }
}
