// POST /api/folders/delete — remove a folder, everything nested under
// it, and every referenced row. Body: { path }. Returns { ok, deleted:
// <note count> }. Always cascades — the client confirms first. Notes
// the caller can't see are skipped, not deleted or counted.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { deleteNotes } from '@/lib/note-paths';
import { logAudit } from '@/lib/audit';
import { findNearestIndexPath, hiddenNotesSql, visibilityFor } from '@/lib/notes';

export const dynamic = 'force-dynamic';

const Body = z.object({
  path: z.string().min(1).max(1024),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot delete folders' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const path = normalizePath(parsed.path);
  if (!path) return json({ error: 'invalid_path' }, 400);

  const db = getDb();
  const groupId = session.currentGroupId;

  // Only the notes the caller can see. Hidden ones (an editor and the
  // admin's gm_only notes) stay where they are and stay out of the
  // `deleted` count, so the folder deletes as if they weren't there.
  const notes = db
    .query<{ path: string }, [string, string, string]>(
      `SELECT path FROM notes n
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')${hiddenNotesSql('n', visibilityFor(session.role))}`,
    )
    .all(groupId, path, path);

  // Also drops the folder's markers, evicts the notes' editors and
  // refreshes the indexes of the folder's parent and every subfolder.
  await deleteNotes({
    groupId,
    userId: session.userId,
    paths: notes.map((n) => n.path),
    folder: path,
  });

  logAudit({
    action: 'folder.destroy',
    actorId: session.userId,
    groupId,
    target: path,
  });

  // Same "redirect to the nearest surviving ancestor page" contract as
  // the single-note delete route — see the comment there. The deleted
  // folder's parent, not the folder itself (which along with its own
  // index.md is now gone).
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const redirectTo = parent ? findNearestIndexPath(groupId, parent) : null;

  return json({ ok: true, deleted: notes.length, redirectTo });
}

function normalizePath(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (clean.split('/').some((s) => s === '..' || s === '.' || s === '')) return '';
  return clean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
