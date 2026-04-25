// GET /api/ui/search?q=<query> — FTS search scoped to the caller's active world.
// Session-authenticated (used by the header search bar).

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { toFtsQuery } from '@/lib/search';
import { GM_MODE_COOKIE, isGmModeOn } from '@/lib/gm-mode';

export const dynamic = 'force-dynamic';

const LIMIT = 20;

type NoteResult = { kind: 'note'; path: string; title: string; snippet: string };
type AssetResult = { kind: 'asset'; id: string; filename: string; contentType: string };
export type UiSearchResult = NoteResult | AssetResult;
export type UiSearchResponse = { query: string; results: UiSearchResult[] };

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (!q) {
    return Response.json({ query: '', results: [] } satisfies UiSearchResponse);
  }

  const db = getDb();
  const fts = toFtsQuery(q);
  // GM-mode searches only the GM namespace; everything else searches
  // the player namespace. Non-admins never see gm_only rows even if
  // they fake the cookie because isGmModeOn requires role=admin.
  const gmMode = isGmModeOn(req.cookies.get(GM_MODE_COOKIE)?.value, session.role);
  const gmOnlyValue = gmMode ? 1 : 0;

  const noteRows = fts
    ? db
        .query<{ path: string; title: string; snippet: string }, [string, string, string, number, number]>(
          // group_id lives directly on notes_fts (migration #33), so
          // MATCH is scoped per world inside the FTS index instead of
          // post-filtering via the JOIN. Cuts work on multi-world
          // servers and removes the cross-world snippet bug when two
          // worlds share a path.
          `SELECT n.path, n.title,
                  snippet(notes_fts, 2, '<mark>', '</mark>', '…', 20) AS snippet
             FROM notes_fts
             JOIN notes n
               ON n.group_id = notes_fts.group_id AND n.path = notes_fts.path
            WHERE notes_fts MATCH ?
              AND notes_fts.group_id = ?
              AND (n.dm_only = 0 OR ? = 1)
              AND n.gm_only = ?
            ORDER BY notes_fts.rank
            LIMIT ${LIMIT}`,
        )
        .all(
          fts,
          session.currentGroupId,
          session.currentGroupId,
          session.role !== 'viewer' ? 1 : 0,
          gmOnlyValue,
        )
    : [];

  const assetRows = db
    .query<{ id: string; filename: string; content_type: string }, [string, string, number]>(
      `SELECT id, filename, content_type
         FROM assets
        WHERE group_id = ?
          AND LOWER(filename) LIKE '%' || LOWER(?) || '%'
        LIMIT ?`,
    )
    .all(session.currentGroupId, q, 5);

  const results: UiSearchResult[] = [
    ...noteRows.map((r) => ({
      kind: 'note' as const,
      path: r.path,
      title: r.title || r.path.split('/').pop()?.replace(/\.(md|canvas)$/i, '') || r.path,
      snippet: r.snippet,
    })),
    ...assetRows.map((r) => ({
      kind: 'asset' as const,
      id: r.id,
      filename: r.filename,
      contentType: r.content_type,
    })),
  ];

  return Response.json({ query: q, results } satisfies UiSearchResponse);
}
