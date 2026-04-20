// POST /api/folders/move — rename or reparent a folder (and everything
// in it). Every path at or under `from` is rewritten to sit at the
// equivalent position under `to`. That includes notes, note_links,
// tags, aliases, the folder_markers table itself, and the FTS mirror.

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
    return json({ error: 'forbidden', reason: 'viewers cannot rename folders' }, 403);
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
  if ((to + '/').startsWith(from + '/')) {
    return json({ error: 'cannot_move_into_self' }, 400);
  }

  const db = getDb();
  const groupId = session.currentGroupId;

  // Every note that lives at or under the folder. We'll need their
  // post-move paths for FTS reseed + collision checking.
  const affected = db
    .query<
      { path: string; title: string; content_text: string },
      [string, string, string]
    >(
      `SELECT path, title, content_text
         FROM notes
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    )
    .all(groupId, from, from);

  if (affected.length === 0) {
    // Folder may be empty but have a marker; still fine.
    const marker = db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM folder_markers WHERE group_id = ? AND path = ?',
      )
      .get(groupId, from);
    if ((marker?.n ?? 0) === 0) return json({ error: 'not_found' }, 404);
  }

  // Reject if any destination path is already taken.
  const moved = affected.map((r) => ({
    from: r.path,
    to: to + r.path.slice(from.length),
    title: r.title,
    content: r.content_text,
  }));
  for (const m of moved) {
    const clash = db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, m.to);
    if ((clash?.n ?? 0) > 0) return json({ error: 'exists', path: m.to }, 409);
  }

  db.transaction(() => {
    for (const m of moved) {
      db.query('UPDATE notes SET path = ? WHERE group_id = ? AND path = ?').run(
        m.to,
        groupId,
        m.from,
      );
      db.query(
        'UPDATE note_links SET from_path = ? WHERE group_id = ? AND from_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE note_links SET to_path = ? WHERE group_id = ? AND to_path = ?',
      ).run(m.to, groupId, m.from);
      db.query('UPDATE tags SET path = ? WHERE group_id = ? AND path = ?').run(
        m.to,
        groupId,
        m.from,
      );
      db.query('UPDATE aliases SET path = ? WHERE group_id = ? AND path = ?').run(
        m.to,
        groupId,
        m.from,
      );
      // Character / session index tables use note_path as PK too.
      db.query(
        'UPDATE characters SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE character_campaigns SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query(
        'UPDATE session_notes SET note_path = ? WHERE group_id = ? AND note_path = ?',
      ).run(m.to, groupId, m.from);
      db.query('DELETE FROM notes_fts WHERE path = ?').run(m.from);
      db.query('INSERT INTO notes_fts(path, title, content) VALUES (?, ?, ?)').run(
        m.to,
        m.title,
        m.content,
      );
    }

    // Folder markers: rewrite the folder itself plus any nested markers.
    const markers = db
      .query<{ path: string }, [string, string, string]>(
        `SELECT path FROM folder_markers
          WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
      )
      .all(groupId, from, from);
    for (const mk of markers) {
      const next = to + mk.path.slice(from.length);
      // Avoid PK collision if the destination already has that marker
      // (unlikely given the collision scan above, but cheap to guard).
      db.query(
        'DELETE FROM folder_markers WHERE group_id = ? AND path = ?',
      ).run(groupId, next);
      db.query(
        'UPDATE folder_markers SET path = ? WHERE group_id = ? AND path = ?',
      ).run(next, groupId, mk.path);
    }

    // Campaign folders: when a Campaigns/<slug> folder is the thing
    // being moved / renamed, the campaigns row needs to follow so
    // the /sessions + /characters dropdowns keep pointing at the
    // right place.
    const campaigns = db
      .query<
        { slug: string; folder_path: string; name: string },
        [string, string, string]
      >(
        `SELECT slug, folder_path, name FROM campaigns
          WHERE group_id = ? AND (folder_path = ? OR folder_path LIKE ? || '/%')`,
      )
      .all(groupId, from, from);
    for (const c of campaigns) {
      const nextPath = to + c.folder_path.slice(from.length);
      const nextSlug = slugify(nextPath.split('/').pop() ?? c.slug);
      // Drop any row that would collide at the destination.
      db.query(
        'DELETE FROM campaigns WHERE group_id = ? AND slug = ? AND slug != ?',
      ).run(groupId, nextSlug, c.slug);
      db.query(
        `UPDATE campaigns
            SET folder_path = ?,
                slug = ?
          WHERE group_id = ? AND slug = ?`,
      ).run(nextPath, nextSlug, groupId, c.slug);
      // Re-home the character_campaigns rows that referenced the
      // old slug. (name stays as the user chose; display-name isn't
      // derived from folder.)
      if (nextSlug !== c.slug) {
        db.query(
          'UPDATE character_campaigns SET campaign_slug = ? WHERE group_id = ? AND campaign_slug = ?',
        ).run(nextSlug, groupId, c.slug);
        db.query(
          'UPDATE session_notes SET campaign_slug = ? WHERE group_id = ? AND campaign_slug = ?',
        ).run(nextSlug, groupId, c.slug);
      }
    }
  })();

  // Kick live editors for every moved note so they reconnect at the
  // new document name.
  for (const m of moved) {
    await closeDocumentConnections(m.from);
  }

  logAudit({
    action: 'folder.rename',
    actorId: session.userId,
    groupId,
    target: `${from} -> ${to}`,
  });

  return json({ ok: true, path: to, moved: moved.length });
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
