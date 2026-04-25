// POST /api/notes/excalidraw-scene — persist an Excalidraw scene blob
// onto a kind:excalidraw note. The scene replaces frontmatter.scene
// wholesale; clients send the full element list every save.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  path: z.string().min(1).max(1024),
  scene: z.object({
    elements: z.array(z.unknown()),
    appState: z.record(z.string(), z.unknown()).optional(),
    files: z.record(z.string(), z.unknown()).optional(),
  }),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  if (session.role === 'viewer') {
    return json({ error: 'forbidden' }, 403);
  }

  const db = getDb();
  const note = db
    .query<{ frontmatter_json: string; gm_only: number }, [string, string]>(
      'SELECT frontmatter_json, gm_only FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, body.path);
  if (!note) return json({ error: 'not_found' }, 404);
  if (note.gm_only === 1 && session.role !== 'admin') {
    return json({ error: 'not_found' }, 404);
  }

  let fm: Record<string, unknown> = {};
  try {
    fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>;
  } catch {
    fm = {};
  }
  if (fm.kind !== 'excalidraw') {
    return json({ error: 'wrong_kind', reason: 'not an excalidraw note' }, 409);
  }

  const nextFm = { ...fm, scene: body.scene };
  db.query(
    `UPDATE notes SET frontmatter_json = ?, updated_at = ?, updated_by = ?
       WHERE group_id = ? AND path = ?`,
  ).run(
    JSON.stringify(nextFm),
    Date.now(),
    session.userId,
    session.currentGroupId,
    body.path,
  );

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
