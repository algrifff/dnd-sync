// GET  /api/notes/<path...> — returns a note's render-ready payload.
// DELETE /api/notes/<path...> — removes the note + cascaded rows.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { decodePath, loadNote, loadTags } from '@/lib/notes';
import { logAudit } from '@/lib/audit';
import { closeDocumentConnections } from '@/collab/server';
import { deriveCampaignIndex, campaignFolderOfPath } from '@/lib/campaign-index';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);
  if (!path) return json({ error: 'invalid_path' }, 400);

  const note = loadNote(session.currentGroupId, path);
  if (!note) return json({ error: 'not_found' }, 404);
  // GM-only notes: only admins can read. 404 instead of 403 so the
  // existence of a GM path isn't disclosed to players.
  if (note.gm_only === 1 && session.role !== 'admin') {
    return json({ error: 'not_found' }, 404);
  }

  const tags = loadTags(session.currentGroupId, path);

  let contentJson: unknown = null;
  let frontmatter: unknown = {};
  try {
    contentJson = JSON.parse(note.content_json);
  } catch {
    contentJson = null;
  }
  try {
    frontmatter = JSON.parse(note.frontmatter_json);
  } catch {
    frontmatter = {};
  }

  return json({
    path: note.path,
    title: note.title,
    contentJson,
    frontmatter,
    tags,
    byteSize: note.byte_size,
    updatedAt: note.updated_at,
  });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot delete notes' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);
  if (!path) return json({ error: 'invalid_path' }, 400);

  const db = getDb();
  db.transaction(() => {
    db.query('DELETE FROM note_links WHERE group_id = ? AND (from_path = ? OR to_path = ?)')
      .run(session.currentGroupId, path, path);
    db.query('DELETE FROM tags WHERE group_id = ? AND path = ?').run(session.currentGroupId, path);
    db.query('DELETE FROM aliases WHERE group_id = ? AND path = ?').run(session.currentGroupId, path);
    db.query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(session.currentGroupId, path);
  })();

  // Kick any live editors so they disconnect instead of trying to
  // persist updates against a row that no longer exists.
  await closeDocumentConnections(path);

  // Refresh the owning campaign's auto-managed index so the deleted
  // note drops out of its table.
  const campaign = campaignFolderOfPath(path);
  if (campaign) {
    try {
      await deriveCampaignIndex(session.currentGroupId, campaign);
    } catch (err) {
      console.error('[notes/delete] campaign index refresh failed:', err);
    }
  }

  logAudit({
    action: 'note.destroy',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
  });

  return json({ ok: true, path });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
