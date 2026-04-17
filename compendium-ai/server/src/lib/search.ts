// FTS5 search helpers. Keeps the route handler thin and makes the query
// construction testable in isolation later.

import { getDb } from './db';

/**
 * Rewrite a human query into an FTS5 MATCH expression.
 * - Tokenises on non-alphanumerics (avoids FTS5 syntax injection entirely).
 * - Each token gets a trailing `*` so "dra" matches "dragon".
 * - Tokens are AND-joined implicitly (FTS5 default).
 */
export function toFtsQuery(input: string): string {
  const tokens = input.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `${t.toLowerCase()}*`).join(' ');
}

export type SearchRow = {
  path: string;
  snippet: string;
  rank: number;
};

export function searchDocs(query: string, limit: number): SearchRow[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  return getDb()
    .query<SearchRow, [string, number]>(
      `SELECT path,
              snippet(text_docs_fts, 1, '<mark>', '</mark>', '…', 20) AS snippet,
              rank
         FROM text_docs_fts
         WHERE text_docs_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
    )
    .all(fts, limit);
}
