// GET /api/tags — list all tags in the group with usage counts. Used
// by the TagEditor's autocomplete popover.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const rows = getDb()
    .query<{ tag: string; count: number }, [string, string]>(
      `SELECT tag, COUNT(*) AS count
         FROM (
           SELECT tag FROM tags WHERE group_id = ?
           UNION ALL
           SELECT tag FROM asset_tags WHERE group_id = ?
         )
         GROUP BY tag
         ORDER BY count DESC, tag ASC
         LIMIT 500`,
    )
    .all(session.currentGroupId, session.currentGroupId);

  return new Response(JSON.stringify({ tags: rows }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=10',
    },
  });
}
