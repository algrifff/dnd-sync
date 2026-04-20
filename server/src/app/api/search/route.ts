// GET /api/search?q=<query>&limit=20 — FTS5 search over text_docs.

import type { NextRequest } from 'next/server';
import type { SearchResponse, SearchResult } from '@compendium/shared';
import { requireRequestAuth } from '@/lib/auth';
import { searchDocs } from '@/lib/search';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  if (!q) {
    return Response.json({ query: '', results: [] } satisfies SearchResponse);
  }

  const rows = searchDocs(q, limit);
  const results: SearchResult[] = rows.map((r) => ({
    path: r.path,
    snippet: r.snippet,
    score: r.rank,
  }));

  return Response.json({ query: q, results } satisfies SearchResponse);
}
