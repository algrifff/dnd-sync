// GET /api/ui/search?q=<query> — FTS search scoped to the caller's active world.
// Session-authenticated (used by the header search bar).

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { toFtsQuery } from '@/lib/search';

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

  const noteRows = fts
    ? db
        .query<{ path: string; title: string; snippet: string }, [string, string, number]>(
          `SELECT n.path, n.title,
                  snippet(notes_fts, 2, '<mark>', '</mark>', '…', 20) AS snippet
             FROM notes_fts
             JOIN notes n ON n.path = notes_fts.path AND n.group_id = ?
            WHERE notes_fts MATCH ?
              AND (n.dm_only = 0 OR ? = 1)
            ORDER BY notes_fts.rank
            LIMIT ${LIMIT}`,
        )
        .all(session.currentGroupId, fts, session.role !== 'viewer' ? 1 : 0)
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
