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
import {
  closeDocumentConnections,
  closeDocumentForWrite,
  releaseServerWrite,
} from '@/collab/server';

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

  // Cheap existence/permission/collision checks BEFORE the drain, so a
  // request that's going to 404/409 doesn't needlessly kick editors.
  // Deliberately does NOT select content_json/content_md/yjs_state —
  // those are re-read fresh after the drain below (see D3: the old
  // code captured a full `src` snapshot here and then drained 20
  // lines later, so `src` was guaranteed to be exactly as stale as
  // whatever the drain's flush had just written — the copy silently
  // lost the source note's last edits).
  const check = db
    .query<{ gm_only: number }, [string, string]>(
      'SELECT gm_only FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, body.fromPath);
  if (!check) return json({ error: 'not_found' }, 404);
  if (check.gm_only !== 1) {
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

  // Both branches read/rewrite the source row's yjs_state, so drain
  // any live editor on it first: copy would otherwise snapshot a
  // stale blob, and move would race the flush (see below).
  const token = await closeDocumentForWrite(session.currentGroupId, body.fromPath);
  try {
    // Re-select the full row AFTER the drain, so `src` reflects whatever
    // the drain's own flush just persisted rather than a pre-drain
    // snapshot. Re-check existence/gm_only too — the drain can take up
    // to 500ms, during which the row could theoretically have changed
    // (e.g. a concurrent promote/delete).
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
      // No post-write evict on fromPath: 'copy' writes a NEW row at
      // toPath and leaves the source row byte-for-byte alone, so
      // nothing in memory for fromPath is stale. The `finally` releases
      // the token rather than evicting — kicking the source note's
      // editors would cost them a reconnect for a write that never
      // touched their document.
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

    // Evict again AFTER the write so anyone who reattached during the
    // transaction re-authenticates against the new gm_only value (and,
    // on rename, stops writing against a path that no longer exists —
    // their store() would silently match zero rows). The token makes
    // this a discard: whatever reattached is holding pre-write state
    // for a row whose path and/or gm_only just changed underneath it.
    await closeDocumentConnections(session.currentGroupId, body.fromPath, token);
    if (toPath !== body.fromPath) {
      // No token for toPath — none was issued for it, and nothing wrote
      // over an in-memory doc there. Plain flush-on-evict is correct.
      await closeDocumentConnections(session.currentGroupId, toPath);
    }

    logAudit({
      action: 'note.move',
      actorId: session.userId,
      groupId: session.currentGroupId,
      target: toPath,
      details: { promotedFrom: body.fromPath, mode: 'move' },
    });
    return json({ ok: true, path: toPath, mode: 'move' }, 200);
  } finally {
    // Covers the post-drain 404/409 re-checks, the 'copy' return, and
    // any throw. No-op once the move branch consumed it.
    releaseServerWrite(token);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
