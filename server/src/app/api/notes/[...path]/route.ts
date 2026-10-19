// GET  /api/notes/<path...> — returns a note's render-ready payload.
// DELETE /api/notes/<path...> — removes the note + cascaded rows.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { deleteNotes } from '@/lib/note-paths';
import {
  decodePath,
  findNearestIndexPath,
  loadTags,
  loadVisibleNote,
  visibilityFor,
} from '@/lib/notes';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);
  if (!path) return json({ error: 'invalid_path' }, 400);

  // A note the caller can't see answers exactly like a missing one.
  const note = loadVisibleNote(session.currentGroupId, path, visibilityFor(session.role));
  if (!note) return json({ error: 'not_found' }, 404);

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
  // A note the caller can't see (an editor and a gm_only note) answers
  // exactly like a missing one, and is left untouched.
  if (!loadVisibleNote(session.currentGroupId, path, visibilityFor(session.role))) {
    return json({ error: 'not_found' }, 404);
  }

  // Evicts live editors and refreshes the parent folder's index too.
  await deleteNotes({ groupId: session.currentGroupId, userId: session.userId, paths: [path] });

  logAudit({
    action: 'note.destroy',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
  });

  // Nearest surviving ancestor page — lets the client redirect a
  // displaced viewer to a real, still-existing page (the containing
  // folder's index) instead of guessing at a path or always bouncing
  // to the dashboard. null when no ancestor has one (e.g. under
  // Assets/Excalidraw) — the client falls back to the dashboard.
  const parentFolder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const redirectTo = parentFolder
    ? findNearestIndexPath(session.currentGroupId, parentFolder)
    : null;

  return json({ ok: true, path, redirectTo });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
