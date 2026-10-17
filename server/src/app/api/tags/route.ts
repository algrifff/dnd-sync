// GET /api/tags — list the tags in the group the caller can see, with
// usage counts. Used by the TagEditor's autocomplete popover. A tag
// that only hidden notes or assets carry is not listed.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { listNoteAndAssetTags, visibilityFor } from '@/lib/notes';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const rows = listNoteAndAssetTags(session.currentGroupId, visibilityFor(session.role), 500);

  return new Response(JSON.stringify({ tags: rows }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=10',
    },
  });
}
