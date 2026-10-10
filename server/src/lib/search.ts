// Search helpers. `searchWorld` backs the header quick-find (/api/ui/search).

import { getDb } from './db';
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from './search-snippet';

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

const TITLE_LIMIT = 12;
const CONTENT_LIMIT = 8;
const ASSET_LIMIT = 5;
const MAX_TOKENS = 6;
// Body hits for one- and two-letter prefixes match nearly every note and
// are the slowest queries; titles alone answer those.
const MIN_CONTENT_QUERY = 3;

export type NoteSearchResult = {
  kind: 'note';
  match: 'title' | 'content';
  path: string;
  title: string;
  /** Raw frontmatter `kind`; the client normalises it for the icon. */
  noteKind: string | null;
  snippet: string | null;
};
export type AssetSearchResult = { kind: 'asset'; id: string; name: string; mime: string };
export type UiSearchResult = NoteSearchResult | AssetSearchResult;

// Guarded so one note with malformed frontmatter can't fail the whole query.
const noteKind = (col: string): string =>
  `CASE WHEN json_valid(${col}) THEN json_extract(${col}, '$.kind') END`;

/** Case- and accent-insensitive form, so "eowyn" finds "Éowyn". SQLite's
 *  lower() only folds ASCII, which is why title matching happens here. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function displayTitle(title: string, path: string): string {
  return title || path.split('/').pop()?.replace(/\.(md|canvas)$/i, '') || path;
}

/** Every token appears in `name`; names starting with the query come
 *  first, then the shortest. */
function rankByName<T>(items: T[], nameOf: (item: T) => string, q: string, limit: number): T[] {
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
  return items
    .map((item) => ({ item, name: fold(nameOf(item)) }))
    .filter(({ name }) => tokens.every((t) => name.includes(t)))
    .sort(
      (a, b) =>
        Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

export function searchWorld(opts: {
  q: string;
  groupId: string;
  role: 'admin' | 'editor' | 'viewer';
  gmMode: boolean;
}): UiSearchResult[] {
  const q = fold(opts.q.trim().replace(/\s+/g, ' '));
  if (!q) return [];

  const db = getDb();
  const gmOnly = opts.gmMode ? 1 : 0;
  const showDmOnly = opts.role !== 'viewer' ? 1 : 0;

  // Title matching scans this world's titles in JS: cheaper than FTS for
  // short prefixes, and it matches mid-word ("grove" finds "Ashgrove").
  const titleHits = rankByName(
    db
      .query<{ path: string; title: string }, [string, number, number]>(
        `SELECT path, title FROM notes
          WHERE group_id = ? AND gm_only = ? AND (dm_only = 0 OR ? = 1)`,
      )
      .all(opts.groupId, gmOnly, showDmOnly)
      .map((r) => ({ path: r.path, title: displayTitle(r.title, r.path) })),
    (r) => r.title,
    q,
    TITLE_LIMIT,
  );
  const titleKinds = new Map(
    titleHits.length === 0
      ? []
      : db
          .query<{ path: string; note_kind: unknown }, string[]>(
            `SELECT path, ${noteKind('frontmatter_json')} AS note_kind FROM notes
              WHERE group_id = ? AND path IN (${titleHits.map(() => '?').join(', ')})`,
          )
          .all(opts.groupId, ...titleHits.map((r) => r.path))
          .map((r) => [r.path, r.note_kind]),
  );

  const fts = q.length >= MIN_CONTENT_QUERY ? toFtsQuery(q) : '';
  const titlePaths = new Set(titleHits.map((r) => r.path));
  const contentRows = fts
    ? db
        .query<{ path: string; title: string; note_kind: unknown; snippet: string }, [string, string, number, number]>(
          `SELECT n.path, n.title, ${noteKind('n.frontmatter_json')} AS note_kind,
                  snippet(notes_fts, 3, '${SNIPPET_MARK_OPEN}', '${SNIPPET_MARK_CLOSE}', '…', 12) AS snippet
             FROM notes_fts
             JOIN notes n
               ON n.group_id = notes_fts.group_id AND n.path = notes_fts.path
            WHERE notes_fts MATCH ?
              AND notes_fts.group_id = ?
              AND (n.dm_only = 0 OR ? = 1)
              AND n.gm_only = ?
            ORDER BY notes_fts.rank
            LIMIT ${CONTENT_LIMIT + TITLE_LIMIT}`,
        )
        .all(fts, opts.groupId, showDmOnly, gmOnly)
        .filter((r) => !titlePaths.has(r.path))
        .slice(0, CONTENT_LIMIT)
    : [];

  const assetHits = rankByName(
    db
      .query<{ id: string; original_name: string; mime: string }, [string, number]>(
        `SELECT id, original_name, mime FROM assets WHERE group_id = ? AND gm_only = ?`,
      )
      .all(opts.groupId, gmOnly),
    (r) => r.original_name,
    q,
    ASSET_LIMIT,
  );

  const kindOf = (raw: unknown): string | null => (typeof raw === 'string' ? raw : null);
  return [
    ...titleHits.map((r): NoteSearchResult => ({
      kind: 'note', match: 'title', path: r.path, title: r.title,
      noteKind: kindOf(titleKinds.get(r.path)), snippet: null,
    })),
    ...contentRows.map((r): NoteSearchResult => ({
      kind: 'note', match: 'content', path: r.path, title: displayTitle(r.title, r.path),
      noteKind: kindOf(r.note_kind), snippet: r.snippet,
    })),
    ...assetHits.map((r): AssetSearchResult => ({ kind: 'asset', id: r.id, name: r.original_name, mime: r.mime })),
  ];
}
