// POST /api/notes/backlink — create an explicit backlink edge.
//
// Body: { fromPath, toPath }
//
// Appends a [[toPath]] wikilink to fromPath's content so the edge is
// visible in that note's body and derives naturally into note_links.
// Idempotent: no-ops if the link already exists in the source note.
//
// Used by the Backlinks sidebar "+" button: the user picks the note
// that should point HERE, and this endpoint writes the link there.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { loadNote } from '@/lib/notes';

export const dynamic = 'force-dynamic';

const Body = z.object({
  fromPath: z.string().min(1).max(512),
  toPath: z.string().min(1).max(512),
});

type PmNode = {
  type: string;
  text?: string;
  content?: PmNode[];
  attrs?: Record<string, unknown>;
};
type PmDoc = { type: 'doc'; content: PmNode[] };

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const { fromPath, toPath } = body;
  if (fromPath === toPath) return json({ error: 'self_link' }, 400);

  const fromNote = loadNote(session.currentGroupId, fromPath);
  if (!fromNote) return json({ error: 'not_found' }, 404);

  const targetBase = toPath.replace(/\.(md|canvas)$/i, '').split('/').pop() ?? toPath;

  if (fromNote.content_md.includes(`[[${targetBase}`)) {
    return json({ ok: true, alreadyExists: true });
  }

  const linkText = `[[${targetBase}]]`;
  const nextMd =
    (fromNote.content_md ?? '').trimEnd() +
    (fromNote.content_md?.trim() ? '\n\n' : '') +
    linkText;

  let doc: PmDoc;
  try {
    doc = JSON.parse(fromNote.content_json) as PmDoc;
  } catch {
    doc = { type: 'doc', content: [] };
  }

  const wikilinkParagraph: PmNode = {
    type: 'paragraph',
    content: [{ type: 'wikilink', attrs: { target: targetBase, label: null, orphan: false } }],
  };
  const nextDoc: PmDoc = { ...doc, content: [...(doc.content ?? []), wikilinkParagraph] };

  const db = getDb();
  db.transaction(() => {
    db.query(
      `UPDATE notes
          SET content_md = ?, content_json = ?, content_text = ?,
              yjs_state = NULL, updated_at = ?, updated_by = ?
        WHERE group_id = ? AND path = ?`,
    ).run(
      nextMd,
      JSON.stringify(nextDoc),
      extractText(nextDoc),
      Date.now(),
      session.userId,
      session.currentGroupId,
      fromPath,
    );
    db.query(
      `INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)`,
    ).run(session.currentGroupId, fromPath, toPath);
  })();

  return json({ ok: true });
}

function extractText(doc: PmDoc): string {
  const parts: string[] = [];
  function walk(node: PmNode): void {
    if (node.text) parts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  }
  for (const child of doc.content) walk(child);
  return parts.join(' ').trim();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
