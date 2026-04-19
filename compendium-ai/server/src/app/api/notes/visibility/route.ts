// PATCH /api/notes/visibility — flip the dm_only flag on a note.
//
// Body: { path, dmOnly: boolean }
//
// Admin + editor only. The flag lives in frontmatter (dmOnly: true)
// so it survives re-ingest; the notes.dm_only column is the
// derived cached copy used for filtering queries.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { loadNote } from '@/lib/notes';

export const dynamic = 'force-dynamic';

const Body = z.object({
  path: z.string().min(1).max(512),
  dmOnly: z.boolean(),
});

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden' }, 403);
  }
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

  const note = loadNote(session.currentGroupId, body.path);
  if (!note) return json({ error: 'not_found' }, 404);

  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>;
  } catch {
    fm = {};
  }
  if (body.dmOnly) fm.dmOnly = true;
  else delete fm.dmOnly;

  getDb()
    .query(
      `UPDATE notes SET frontmatter_json = ?, dm_only = ?,
                        updated_at = ?, updated_by = ?
         WHERE group_id = ? AND path = ?`,
    )
    .run(
      JSON.stringify(fm),
      body.dmOnly ? 1 : 0,
      Date.now(),
      session.userId,
      session.currentGroupId,
      body.path,
    );

  return json({ ok: true, dmOnly: body.dmOnly });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
