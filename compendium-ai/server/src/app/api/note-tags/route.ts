// PATCH /api/note-tags — replace the tag set for a single note.
// Writes both frontmatter.tags (persisted source of truth) and the
// tags table row (read by the graph, sidebar, FTS). Inline #hashtags
// in the body are left alone; derive re-unions them on the next body
// save.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { loadNote } from '@/lib/notes';
import type { PmNode } from '@/lib/md-to-pm';

export const dynamic = 'force-dynamic';

const TagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_\-/]+$/, 'tags must be alphanumeric plus _-/');

const Body = z.object({
  path: z.string().min(1).max(512),
  tags: z.array(TagSchema).max(64),
});

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot edit tags' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const note = loadNote(session.currentGroupId, body.path);
  if (!note) return json({ error: 'not_found' }, 404);

  const normalised = [...new Set(body.tags.map((t) => t.replace(/^#/, '').toLowerCase()))];

  // Merge into frontmatter_json so the next yjs persist derive picks
  // it up correctly. We keep unrelated frontmatter keys untouched.
  let fm: Record<string, unknown> = {};
  try {
    fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>;
  } catch {
    fm = {};
  }
  fm.tags = normalised;

  // Compute the inline tag set from the current content so we can
  // rebuild the tags table as union(inline, frontmatter).
  let contentJson: PmNode | null = null;
  try {
    contentJson = JSON.parse(note.content_json) as PmNode;
  } catch {
    contentJson = null;
  }
  const inlineTags = contentJson ? collectInlineTags(contentJson) : [];
  const union = [...new Set([...inlineTags, ...normalised])];

  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    db.query(
      'UPDATE notes SET frontmatter_json = ?, updated_at = ? WHERE group_id = ? AND path = ?',
    ).run(JSON.stringify(fm), now, session.currentGroupId, body.path);

    db.query('DELETE FROM tags WHERE group_id = ? AND path = ?').run(
      session.currentGroupId,
      body.path,
    );
    const insertTag = db.query(
      'INSERT OR IGNORE INTO tags (group_id, path, tag) VALUES (?, ?, ?)',
    );
    for (const tag of union) insertTag.run(session.currentGroupId, body.path, tag);
  })();

  logAudit({
    action: 'note.create', // reuse — we don't have a note.update action yet
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: body.path,
    details: { tagsUpdated: normalised.length },
  });

  return json({ ok: true, tags: union });
}

function collectInlineTags(doc: PmNode): string[] {
  const out = new Set<string>();
  walk(doc);
  return [...out];

  function walk(n: PmNode): void {
    if (n.type === 'tagMention') {
      const t = String(n.attrs?.tag ?? '').toLowerCase();
      if (t) out.add(t);
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
