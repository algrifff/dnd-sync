// POST /api/notes/create — create an empty note at the given path.
// Body: { folder: string, name: string }  (name does NOT need .md;
// the server appends it). Returns 201 { path }.

import { randomUUID } from 'node:crypto';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const Body = z.object({
  folder: z.string().max(512),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\\0]+$/, 'name must not contain slashes or null bytes'),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot create notes' }, 403);
  }

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    const body = await req.json();
    parsed = Body.parse(body);
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const folder = parsed.folder.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (folder.split('/').some((p) => p === '..' || p === '.')) {
    return json({ error: 'invalid_folder' }, 400);
  }
  const cleanName = parsed.name.trim().replace(/\.(md|canvas)$/i, '');
  if (!cleanName) return json({ error: 'invalid_name' }, 400);
  const path = (folder ? folder + '/' : '') + cleanName + '.md';

  const db = getDb();
  const existing = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, path);
  if ((existing?.n ?? 0) > 0) {
    return json({ error: 'exists', path }, 409);
  }

  // Seed a Y.Doc with the title as an H1 + an empty paragraph so the
  // note shows a visible title the moment it opens. deriveAndPersist
  // picks up the H1 as notes.title on every save, so typing into that
  // H1 is exactly how the user renames.
  const emptyDoc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: cleanName }],
      },
      { type: 'paragraph' },
    ],
  };
  const schema = getPmSchema();
  const ydoc = prosemirrorJSONToYDoc(schema, emptyDoc, 'default');
  const state = Y.encodeStateAsUpdate(ydoc);

  const id = randomUUID();
  const now = Date.now();
  db.query(
    `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                        content_md, yjs_state, frontmatter_json, byte_size,
                        updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session.currentGroupId,
    path,
    cleanName,
    JSON.stringify(emptyDoc),
    '',
    '',
    state,
    '{}',
    0,
    now,
    session.userId,
  );

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
  });

  return json({ ok: true, path }, 201);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
