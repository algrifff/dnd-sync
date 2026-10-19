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
//
// lib/note-paths does the copy and the rename, carrying every row
// keyed by the note's path.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { isAllowedPath } from '@/lib/notes';
import { copyNote, renameNotes } from '@/lib/note-paths';
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
  const groupId = session.currentGroupId;

  // Cheap existence/permission/collision checks BEFORE the drain, so a
  // request that's going to 404/409 doesn't needlessly kick editors.
  const check = gmOnlyOf(groupId, body.fromPath);
  if (check === undefined) return json({ error: 'not_found' }, 404);
  if (check !== 1) {
    return json({ error: 'not_gm_only', reason: 'source note is already in the player namespace' }, 409);
  }

  const collide = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, toPath);
  if ((collide?.n ?? 0) > 0 && toPath !== body.fromPath) {
    return json({ error: 'exists', path: toPath }, 409);
  }

  // Both branches read/rewrite the source row's yjs_state, so drain
  // any live editor on it first: copy would otherwise snapshot a
  // stale blob, and move would race the flush (see below).
  const token = await closeDocumentForWrite(groupId, body.fromPath);
  try {
    // Re-check AFTER the drain: it can take up to 500ms, during which
    // the row could have changed (e.g. a concurrent promote/delete).
    // The copy itself reads the row inside its own transaction, so it
    // takes whatever the drain's flush just persisted.
    const gmOnly = gmOnlyOf(groupId, body.fromPath);
    if (gmOnly === undefined) return json({ error: 'not_found' }, 404);
    if (gmOnly !== 1) {
      return json({ error: 'not_gm_only', reason: 'source note is already in the player namespace' }, 409);
    }

    if (body.mode === 'copy') {
      // The collide check above is a fast path; the drain gives a
      // concurrent create time to win. UNIQUE(group_id, path) decides.
      const copied = await copyNote({
        groupId,
        userId: session.userId,
        from: body.fromPath,
        to: toPath,
        dmOnly: false,
        gmOnly: false,
      });
      if (!copied.ok) return failure(copied);
      logAudit({
        action: 'note.create',
        actorId: session.userId,
        groupId,
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

    // move: flip gm_only and (optionally) rename in one transaction. On
    // a lost race the transaction rolls back and the source is untouched.
    const moved = await renameNotes({
      groupId,
      userId: session.userId,
      moves: [{ from: body.fromPath, to: toPath }],
      inTransaction: () => {
        db.query(
          'UPDATE notes SET gm_only = 0, updated_at = ?, updated_by = ? WHERE group_id = ? AND path = ?',
        ).run(Date.now(), session.userId, groupId, toPath);
      },
    });
    if (!moved.ok) return failure(moved);

    // Evict again AFTER the write so anyone who reattached during the
    // transaction re-authenticates against the new gm_only value (and,
    // on rename, stops writing against a path that no longer exists —
    // their store() would silently match zero rows). The token makes
    // this a discard: whatever reattached is holding pre-write state
    // for a row whose path and/or gm_only just changed underneath it.
    await closeDocumentConnections(groupId, body.fromPath, token);
    if (toPath !== body.fromPath) {
      // No token for toPath — none was issued for it, and nothing wrote
      // over an in-memory doc there. Plain flush-on-evict is correct.
      await closeDocumentConnections(groupId, toPath);
    }

    logAudit({
      action: 'note.move',
      actorId: session.userId,
      groupId,
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

function gmOnlyOf(groupId: string, path: string): number | undefined {
  return getDb()
    .query<{ gm_only: number }, [string, string]>(
      'SELECT gm_only FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path)?.gm_only;
}

function failure(err: { error: 'not_found' | 'exists'; path: string }): Response {
  return err.error === 'exists'
    ? json({ error: 'exists', path: err.path }, 409)
    : json({ error: 'not_found' }, 404);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
