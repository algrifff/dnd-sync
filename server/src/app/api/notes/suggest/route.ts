// GET /api/notes/suggest?kind=location&q=<query>
//
// Typeahead over the derived-index tables (locations / characters /
// creatures / items). Used by the SheetHeader's NoteAutocomplete for
// linking a person to their home, a location to its parent, etc.
//
// Scoped to the caller's active group and limited to 10 hits to keep
// the popup quick. Case-insensitive prefix + substring match on name,
// substring match on path. No FTS — the index tables are small and
// an ILIKE scan is fine.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const LIMIT = 10;

const ALLOWED_KINDS = new Set([
  'location',
  'character',
  'creature',
  'item',
]);

export type NoteSuggestHit = {
  path: string;
  name: string;
};
export type NoteSuggestResponse = { results: NoteSuggestHit[] };

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const kind = (url.searchParams.get('kind') ?? '').toLowerCase();
  const q = (url.searchParams.get('q') ?? '').trim();

  if (!ALLOWED_KINDS.has(kind)) {
    return Response.json(
      { error: 'invalid_kind', reason: 'kind must be one of ' + [...ALLOWED_KINDS].join(', ') },
      { status: 400 },
    );
  }

  const table = {
    location: 'locations',
    character: 'characters',
    creature: 'creatures',
    item: 'items',
  }[kind]!;

  const db = getDb();
  const needle = `%${q}%`;

  // Prefer entries whose name starts with q, then contains q, then path.
  const rows = q
    ? db
        .query<
          { path: string; name: string },
          [string, string, string, string, string]
        >(
          `SELECT note_path AS path, name
             FROM ${table}
            WHERE group_id = ?
              AND (name LIKE ? COLLATE NOCASE
                   OR name LIKE ? COLLATE NOCASE
                   OR note_path LIKE ? COLLATE NOCASE)
            ORDER BY CASE
              WHEN name LIKE ? COLLATE NOCASE THEN 0
              ELSE 1
            END, name COLLATE NOCASE
            LIMIT ${LIMIT}`,
        )
        .all(
          session.currentGroupId,
          `${q}%`,
          needle,
          needle,
          `${q}%`,
        )
    : db
        .query<{ path: string; name: string }, [string]>(
          `SELECT note_path AS path, name
             FROM ${table}
            WHERE group_id = ?
            ORDER BY name COLLATE NOCASE
            LIMIT ${LIMIT}`,
        )
        .all(session.currentGroupId);

  return Response.json({ results: rows } satisfies NoteSuggestResponse);
}
