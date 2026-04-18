// GET /api/notes/<path...> — returns a note's render-ready payload.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { decodePath, loadNote, loadTags } from '@/lib/notes';

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
