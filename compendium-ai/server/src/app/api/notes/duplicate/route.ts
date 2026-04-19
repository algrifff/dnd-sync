// POST /api/notes/duplicate — clone an existing note to a new path.
// Body: { path }. Auto-picks "<name> (copy).md", incrementing the
// suffix on conflict. Copies yjs_state bytewise so the new doc opens
// with the same Y.Doc state; note_links (from side) and tags are
// copied so the new page retains its outgoing references. Aliases
// are NOT copied — the user can add new aliases if they want.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const Body = z.object({ path: z.string().min(1).max(512) });

type NoteRow = {
  id: string;
  path: string;
  title: string;
  content_json: string;
  content_text: string;
  content_md: string;
  yjs_state: Uint8Array | null;
  frontmatter_json: string;
  byte_size: number;
};

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot duplicate notes' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const src = getDb()
    .query<NoteRow, [string, string]>(
      `SELECT id, path, title, content_json, content_text, content_md,
              yjs_state, frontmatter_json, byte_size
         FROM notes WHERE group_id = ? AND path = ?`,
    )
    .get(session.currentGroupId, body.path);
  if (!src) return json({ error: 'not_found' }, 404);

  const newPath = nextAvailablePath(session.currentGroupId, body.path);
  const newTitle = deriveTitle(src.title, newPath);

  const id = randomUUID();
  const now = Date.now();
  const db = getDb();
  db.transaction(() => {
    db.query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      session.currentGroupId,
      newPath,
      newTitle,
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
    // Copy outgoing links + tags only. Inbound links (note_links where
    // to_path = src.path) shouldn't auto-point at the duplicate.
    for (const { to_path } of db
      .query<{ to_path: string }, [string, string]>(
        'SELECT to_path FROM note_links WHERE group_id = ? AND from_path = ?',
      )
      .all(session.currentGroupId, src.path)) {
      db.query('INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)')
        .run(session.currentGroupId, newPath, to_path);
    }
    for (const { tag } of db
      .query<{ tag: string }, [string, string]>(
        'SELECT tag FROM tags WHERE group_id = ? AND path = ?',
      )
      .all(session.currentGroupId, src.path)) {
      db.query('INSERT OR IGNORE INTO tags (group_id, path, tag) VALUES (?, ?, ?)')
        .run(session.currentGroupId, newPath, tag);
    }
  })();

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: newPath,
    details: { duplicatedFrom: src.path },
  });

  return json({ ok: true, path: newPath }, 201);
}

function nextAvailablePath(groupId: string, origPath: string): string {
  const idx = origPath.lastIndexOf('/');
  const dir = idx >= 0 ? origPath.slice(0, idx + 1) : '';
  const leaf = origPath.slice(idx + 1).replace(/\.md$/i, '');
  for (let i = 1; i < 1000; i++) {
    const candidate = `${dir}${leaf} (copy${i > 1 ? ' ' + i : ''}).md`;
    const row = getDb()
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, candidate);
    if ((row?.n ?? 0) === 0) return candidate;
  }
  throw new Error('too many duplicates of ' + origPath);
}

function deriveTitle(origTitle: string, newPath: string): string {
  const leaf = (newPath.split('/').pop() ?? newPath).replace(/\.md$/i, '');
  if (origTitle && origTitle.length > 0) return `${origTitle} (copy)`;
  return leaf;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
