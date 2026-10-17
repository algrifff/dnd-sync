// GET /api/notes/suggest?kind=location&q=<query>
//
// Typeahead over the derived-index tables (locations / characters /
// creatures / items). Used by the SheetHeader's NoteAutocomplete for
// linking a person to their home, a location to its parent, etc.
//
// Scoped to the caller's active group, skipping notes hidden from the
// caller's role, and limited to 10 hits to keep the popup quick.
// Case-insensitive prefix + substring match on name, substring match
// on path. No FTS — the index tables are small and an ILIKE scan is
// fine.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { hiddenNotesSql, visibilityFor } from '@/lib/notes';

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

  // The characters index calls its name column display_name.
  const { table, name } = {
    location: { table: 'locations', name: 'x.name' },
    character: { table: 'characters', name: 'x.display_name' },
    creature: { table: 'creatures', name: 'x.name' },
    item: { table: 'items', name: 'x.name' },
  }[kind]!;

  // A hit would leak a hidden note's name and path, so the index row
  // is joined to its note and filtered by the caller's role.
  const from = `FROM ${table} x
         JOIN notes n ON n.group_id = x.group_id AND n.path = x.note_path
        WHERE x.group_id = ?${hiddenNotesSql('n', visibilityFor(session.role))}`;

  const db = getDb();
  const needle = `%${q}%`;

  // Prefer entries whose name starts with q, then contains q, then path.
  const rows = q
    ? db
        .query<
          { path: string; name: string },
          [string, string, string, string, string]
        >(
          `SELECT x.note_path AS path, ${name} AS name
             ${from}
              AND (${name} LIKE ? COLLATE NOCASE
                   OR ${name} LIKE ? COLLATE NOCASE
                   OR x.note_path LIKE ? COLLATE NOCASE)
            ORDER BY CASE
              WHEN ${name} LIKE ? COLLATE NOCASE THEN 0
              ELSE 1
            END, ${name} COLLATE NOCASE
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
          `SELECT x.note_path AS path, ${name} AS name
             ${from}
            ORDER BY ${name} COLLATE NOCASE
            LIMIT ${LIMIT}`,
        )
        .all(session.currentGroupId);

  return Response.json({ results: rows } satisfies NoteSuggestResponse);
}
