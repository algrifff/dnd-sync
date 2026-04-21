// POST   /api/notes/backlink — create a manual backlink edge.
// DELETE /api/notes/backlink — remove a manual backlink edge.
//
// Both operate only on the note_links table (is_manual = 1) and never
// touch note content. This avoids corrupting the Y.Doc / title field
// which lives only in yjs_state and is NOT reflected in content_json.
//
// Body: { fromPath, toPath }
//
// POST:   INSERT OR IGNORE into note_links with is_manual=1. Idempotent.
// DELETE: DELETE WHERE is_manual=1. Body-derived links (is_manual=0) are
//         managed exclusively by derive.ts; the UI hides × on those.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { loadNote } from '@/lib/notes';

export const dynamic = 'force-dynamic';

const Body = z.object({
  fromPath: z.string().min(1).max(512),
  toPath: z.string().min(1).max(512),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const { fromPath, toPath } = body;
  if (fromPath === toPath) return json({ error: 'self_link' }, 400);

  // Verify both notes exist in this group.
  if (!loadNote(session.currentGroupId, fromPath)) return json({ error: 'from_not_found' }, 404);

  getDb()
    .query(
      `INSERT OR IGNORE INTO note_links (group_id, from_path, to_path, is_manual)
       VALUES (?, ?, ?, 1)`,
    )
    .run(session.currentGroupId, fromPath, toPath);

  return json({ ok: true });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const { fromPath, toPath } = body;

  // Only delete manual links — body-derived links (is_manual=0) are
  // managed by derive.ts and must not be removed here.
  getDb()
    .query(
      `DELETE FROM note_links
        WHERE group_id = ? AND from_path = ? AND to_path = ? AND is_manual = 1`,
    )
    .run(session.currentGroupId, fromPath, toPath);

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
