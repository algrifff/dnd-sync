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
import { hasControlChars, loadVisibleNote, visibilityFor } from '@/lib/notes';
import { getDb, isUniqueConstraintError } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { closeDocumentConnections } from '@/collab/server';
import { assertMoveAllowed } from '@/lib/move-policy';
import { findWikilinkLinkers, rewriteWikilinksForLinkers } from '@/lib/move-rewrite';
import { deriveFolderIndexesFor } from '@/lib/campaign-index';
import { repointSuggestionPaths } from '@/lib/suggestion-paths';
import { repointRelations } from '@/lib/relations';

export const dynamic = 'force-dynamic';

const Body = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024).refine((p) => !hasControlChars(p), 'path must not contain control characters'),
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

  const policy = assertMoveAllowed({ kind: 'file', from, to });
  if (!policy.ok) return json({ error: policy.error, reason: policy.reason }, 403);

  // A note the caller can't see (an editor and a gm_only note) answers
  // exactly like a missing one.
  if (!loadVisibleNote(session.currentGroupId, from, visibilityFor(session.role))) {
    return json({ error: 'not_found' }, 404);
  }

  const db = getDb();
  const collide = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, to);
  if ((collide?.n ?? 0) > 0) return json({ error: 'exists', path: to }, 409);

  // The transaction repoints every incoming edge, so linkers must be
  // discovered first.
  const linkers = findWikilinkLinkers(session.currentGroupId, [from]);

  try {
    db.transaction(() => {
      // Derived-index tables (characters, session_notes, character_campaigns)
      // hold FKs on notes(group_id, path) with ON DELETE CASCADE but no
      // ON UPDATE CASCADE — without deferring, the UPDATE on notes below
      // would trip SQLITE_CONSTRAINT_FOREIGNKEY before we get a chance to
      // rewrite the dependent rows. Defer until COMMIT so the whole
      // transaction is checked once everything is consistent.
      db.exec('PRAGMA defer_foreign_keys = 1');
      // Bump updated_at so the in-process tree cache snapshot key changes
      // AND the /api/tree ETag rotates. Without this the client refetches
      // /api/tree, gets 304, re-renders the stale tree, and the row snaps
      // back to the old position.
      db.query(
        'UPDATE notes SET path = ?, updated_at = ?, updated_by = ? WHERE group_id = ? AND path = ?',
      ).run(
        to,
        Date.now(),
        session.userId,
        session.currentGroupId,
        from,
      );
      // note_links is keyed (group_id, from_path, to_path), and a stale
      // edge to or from `to` can exist even with no note there (derive
      // re-adds orphan edges). OR IGNORE leaves the colliding rows behind
      // and the DELETE drops them, merging instead of failing the move.
      for (const col of ['from_path', 'to_path'] as const) {
        db.query(
          `UPDATE OR IGNORE note_links SET ${col} = ? WHERE group_id = ? AND ${col} = ?`,
        ).run(to, session.currentGroupId, from);
        db.query(`DELETE FROM note_links WHERE group_id = ? AND ${col} = ?`).run(
          session.currentGroupId,
          from,
        );
      }
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
      // Structured-note index tables also use note_path as the key. Each
      // of these holds an FK on notes(group_id, path); the deferred-FK
      // pragma above lets us update them in any order, but every table
      // pointing at the old path must be rewritten before COMMIT.
      db.query(
        'UPDATE characters SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(to, session.currentGroupId, from);
      db.query(
        'UPDATE character_campaigns SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(to, session.currentGroupId, from);
      db.query(
        'UPDATE session_notes SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(to, session.currentGroupId, from);
      // Suggestions name the Character and Session by path (no FK).
      repointSuggestionPaths(session.currentGroupId, from, to);
      repointRelations(session.currentGroupId, from, to);
      db.query(
        'UPDATE items SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(to, session.currentGroupId, from);
      db.query(
        'UPDATE locations SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(to, session.currentGroupId, from);
      db.query(
        'UPDATE creatures SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(to, session.currentGroupId, from);
      // locations.parent_path is a soft reference (no FK), but rewrite it
      // anyway so children stay anchored to the renamed parent.
      db.query(
        'UPDATE locations SET parent_path = ? WHERE group_id = ? AND parent_path = ?',
      ).run(to, session.currentGroupId, from);
      // users.active_character_path is also a soft reference — any user
      // who pinned this note as their active PC needs the path rewritten
      // so the party sidebar / chat context don't lose track of them.
      db.query(
        'UPDATE users SET active_character_path = ? WHERE active_character_path = ?',
      ).run(to, from);
    })();
  } catch (err) {
    // The collide check above is a fast path; a concurrent move or
    // create onto `to` lands here, and the transaction has rolled back.
    // Only a note really sitting at `to` is a name conflict; any other
    // constraint failure is a bug and must surface, not read as "exists".
    if (isUniqueConstraintError(err) && noteExists(session.currentGroupId, to)) {
      return json({ error: 'exists', path: to }, 409);
    }
    throw err;
  }

  await closeDocumentConnections(session.currentGroupId, from);

  // Rewrite wikilink targets in every note that pointed at the old
  // path, then kick their live editors so they pull the rewritten body.
  try {
    const touched = rewriteWikilinksForLinkers(
      session.currentGroupId,
      linkers,
      [{ from, to }],
      session.userId,
    );
    for (const linker of touched) await closeDocumentConnections(session.currentGroupId, linker);
  } catch (err) {
    console.error('[notes/move] wikilink rewrite failed:', err);
  }

  // Refresh the auto-managed index pages of both folders the note
  // touched — source and destination. They may be the same folder
  // (rename only), different folders in the same campaign, different
  // campaigns, or non-campaign paths (skipped).
  await deriveFolderIndexesFor(
    session.currentGroupId,
    [from, to],
    { userId: session.userId },
  );

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

function noteExists(groupId: string, path: string): boolean {
  return (
    getDb()
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, path)?.n === 1
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
