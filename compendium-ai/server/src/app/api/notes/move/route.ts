// POST /api/notes/move — rename / reparent a single note.
// Body: { from: string, to: string }. Rewrites notes.path, the two
// note_links columns, tags.path, and the FTS mirror. The Y.Doc blob
// stays on the existing row (it's keyed by id, not path), so live
// editors just need to reconnect with the new document name — we kick
// them so peers get a fresh session on the renamed path.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { closeDocumentConnections } from '@/collab/server';

export const dynamic = 'force-dynamic';

const Body = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot rename notes' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const from = normalizePath(parsed.from);
  const to = normalizePath(parsed.to);
  if (!from || !to) return json({ error: 'invalid_path' }, 400);
  if (from === to) return json({ ok: true, path: to });

  const db = getDb();
  const existing = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, from);
  if ((existing?.n ?? 0) === 0) return json({ error: 'not_found' }, 404);

  const collide = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, to);
  if ((collide?.n ?? 0) > 0) return json({ error: 'exists', path: to }, 409);

  // Pull content for the FTS reinsert.
  const row = db
    .query<{ title: string; content_text: string }, [string, string]>(
      'SELECT title, content_text FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, from);

  db.transaction(() => {
    db.query('UPDATE notes SET path = ? WHERE group_id = ? AND path = ?').run(
      to,
      session.currentGroupId,
      from,
    );
    db.query('UPDATE note_links SET from_path = ? WHERE group_id = ? AND from_path = ?').run(
      to,
      session.currentGroupId,
      from,
    );
    db.query('UPDATE note_links SET to_path = ? WHERE group_id = ? AND to_path = ?').run(
      to,
      session.currentGroupId,
      from,
    );
    db.query('UPDATE tags SET path = ? WHERE group_id = ? AND path = ?').run(
      to,
      session.currentGroupId,
      from,
    );
    db.query('UPDATE aliases SET path = ? WHERE group_id = ? AND path = ?').run(
      to,
      session.currentGroupId,
      from,
    );
    // FTS mirror — triggers fire on title/content_text updates, not on
    // path, so reseed manually.
    db.query('DELETE FROM notes_fts WHERE path = ?').run(from);
    if (row) {
      db.query('INSERT INTO notes_fts(path, title, content) VALUES (?, ?, ?)').run(
        to,
        row.title,
        row.content_text,
      );
    }
  })();

  await closeDocumentConnections(from);

  logAudit({
    action: 'note.rename',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: `${from} -> ${to}`,
  });

  return json({ ok: true, path: to });
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
