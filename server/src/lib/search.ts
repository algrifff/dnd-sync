// FTS5 search helpers. Keeps the route handler thin and makes the query
// construction testable in isolation later.

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
