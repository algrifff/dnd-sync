// POST /api/folders/delete — remove a folder, everything nested under
// it, and every referenced row. Body: { path }. Returns { ok, deleted:
// <note count> }. Always cascades — the client confirms first.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { closeDocumentConnections } from '@/collab/server';

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

  const notes = db
    .query<{ path: string }, [string, string, string]>(
      `SELECT path FROM notes
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    )
    .all(groupId, path, path);

  db.transaction(() => {
    for (const n of notes) {
      db.query(
        'DELETE FROM note_links WHERE group_id = ? AND (from_path = ? OR to_path = ?)',
      ).run(groupId, n.path, n.path);
      db.query('DELETE FROM tags WHERE group_id = ? AND path = ?').run(groupId, n.path);
      db.query('DELETE FROM aliases WHERE group_id = ? AND path = ?').run(groupId, n.path);
      db.query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(groupId, n.path);
      db.query('DELETE FROM notes_fts WHERE path = ? AND group_id = ?').run(
        n.path,
        groupId,
      );
    }
    db.query(
      `DELETE FROM folder_markers
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    ).run(groupId, path, path);
  })();

  for (const n of notes) {
    await closeDocumentConnections(n.path);
  }

  logAudit({
    action: 'folder.destroy',
    actorId: session.userId,
    groupId,
    target: path,
  });

  return json({ ok: true, deleted: notes.length });
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
