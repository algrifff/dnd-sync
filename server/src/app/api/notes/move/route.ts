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
import { assertMoveAllowed } from '@/lib/move-policy';
import { rewriteWikilinksForRenames } from '@/lib/move-rewrite';
import { deriveFolderIndexesFor } from '@/lib/campaign-index';

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

  const policy = assertMoveAllowed({ kind: 'file', from, to });
  if (!policy.ok) return json({ error: policy.error, reason: policy.reason }, 403);

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
    db.query('UPDATE notes SET path = ?, updated_at = ? WHERE group_id = ? AND path = ?').run(
      to,
      Date.now(),
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
    // FTS mirror — triggers fire on title/content_text updates, not on
    // path, so reseed manually. group_id is part of the FTS row since
    // migration #33 to keep MATCH queries scoped per world.
    db.query('DELETE FROM notes_fts WHERE path = ? AND group_id = ?').run(
      from,
      session.currentGroupId,
    );
    if (row) {
      db.query(
        'INSERT INTO notes_fts(path, group_id, title, content) VALUES (?, ?, ?, ?)',
      ).run(to, session.currentGroupId, row.title, row.content_text);
    }
  })();

  await closeDocumentConnections(from);

  // Rewrite wikilink targets in every note that pointed at the old
  // path, then kick their live editors so they pull the rewritten
  // body. Done after the move transaction so note_links is already in
  // its final shape (the linker's edge for `to_path = from` is gone,
  // but rewriteWikilinksForRenames re-derives from content_json).
  // Actually no — we need to query note_links BEFORE the transaction
  // rewrites them. Doing it here works because the move route only
  // updates note_links rows where the moved note is the from_path or
  // to_path of an OUTGOING/INCOMING edge owned by the moved note —
  // edges from OTHER notes pointing at the moved note are untouched
  // by the route's UPDATE. So linkers are still discoverable here.
  try {
    const touched = rewriteWikilinksForRenames(session.currentGroupId, [
      { from, to },
    ]);
    for (const linker of touched) await closeDocumentConnections(linker);
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
