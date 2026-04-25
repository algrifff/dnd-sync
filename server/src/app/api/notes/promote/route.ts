// POST /api/notes/promote — copy or move a GM-only note into the
// player namespace (gm_only=0). Admin-only. Body:
//   { fromPath: string, toPath?: string, mode: 'copy' | 'move' }
//
// 'copy' clones the note (new id, same content + yjs_state) into the
// player namespace. The GM original stays gm_only=1.
// 'move' flips gm_only on the existing row from 1 → 0 (and renames
// the path if toPath is supplied). The yjs_state is preserved so any
// admins still editing the doc don't lose their session — players
// will pick up the live state when they open it. Document this in
// the route comment because move-promote leaks edit history.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { isAllowedPath } from '@/lib/notes';

export const dynamic = 'force-dynamic';

const Body = z.object({
  fromPath: z.string().min(1).max(512),
  toPath: z.string().min(1).max(512).optional(),
  mode: z.enum(['copy', 'move']),
});

type Row = {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  content_md: string;
  yjs_state: Uint8Array | null;
  frontmatter_json: string;
  byte_size: number;
  gm_only: number;
};

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role !== 'admin') {
    return json({ error: 'forbidden', reason: 'GM promote is admin-only' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const toPath = (body.toPath ?? body.fromPath).trim();
  const allowed = isAllowedPath(toPath.replace(/\.md$/i, ''));
  if (!allowed.ok) {
    return json({ error: 'forbidden', reason: allowed.reason }, 403);
  }

  const db = getDb();
  const src = db
    .query<Row, [string, string]>(
      `SELECT id, title, content_json, content_text, content_md, yjs_state,
              frontmatter_json, byte_size, gm_only
         FROM notes WHERE group_id = ? AND path = ?`,
    )
    .get(session.currentGroupId, body.fromPath);
  if (!src) return json({ error: 'not_found' }, 404);
  if (src.gm_only !== 1) {
    return json({ error: 'not_gm_only', reason: 'source note is already in the player namespace' }, 409);
  }

  const collide = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, toPath);
  if ((collide?.n ?? 0) > 0 && toPath !== body.fromPath) {
    return json({ error: 'exists', path: toPath }, 409);
  }

  const now = Date.now();

  if (body.mode === 'copy') {
    const newId = randomUUID();
    db.query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by, gm_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      newId,
      session.currentGroupId,
      toPath,
      src.title,
      src.content_json,
      src.content_text,
      src.content_md,
      src.yjs_state,
      src.frontmatter_json,
      src.byte_size,
      now,
      session.userId,
      now,
      session.userId,
    );
    logAudit({
      action: 'note.create',
      actorId: session.userId,
      groupId: session.currentGroupId,
      target: toPath,
      details: { promotedFrom: body.fromPath, mode: 'copy' },
    });
    return json({ ok: true, path: toPath, mode: 'copy' }, 201);
  }

  // move: flip gm_only and (optionally) rename in one transaction.
  db.transaction(() => {
    if (toPath === body.fromPath) {
      db.query(
        'UPDATE notes SET gm_only = 0, updated_at = ?, updated_by = ? WHERE group_id = ? AND path = ?',
      ).run(now, session.userId, session.currentGroupId, body.fromPath);
    } else {
      db.query(
        'UPDATE notes SET gm_only = 0, path = ?, updated_at = ?, updated_by = ? WHERE group_id = ? AND path = ?',
      ).run(toPath, now, session.userId, session.currentGroupId, body.fromPath);
      // Rewire backlinks pointing at the old path so the graph stays
      // consistent. Outgoing links (from_path) follow the rename too.
      db.query('UPDATE note_links SET to_path = ? WHERE group_id = ? AND to_path = ?')
        .run(toPath, session.currentGroupId, body.fromPath);
      db.query('UPDATE note_links SET from_path = ? WHERE group_id = ? AND from_path = ?')
        .run(toPath, session.currentGroupId, body.fromPath);
      db.query('UPDATE tags SET path = ? WHERE group_id = ? AND path = ?')
        .run(toPath, session.currentGroupId, body.fromPath);
    }
  })();
  logAudit({
    action: 'note.move',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: toPath,
    details: { promotedFrom: body.fromPath, mode: 'move' },
  });
  return json({ ok: true, path: toPath, mode: 'move' }, 200);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
