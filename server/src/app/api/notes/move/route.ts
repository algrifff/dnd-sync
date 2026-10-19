// POST /api/notes/move — rename / reparent a single note.
// Body: { from: string, to: string }. lib/note-paths carries the note and
// every row keyed by its path. The Y.Doc blob stays on the existing row
// (it's keyed by id, not path), so live editors just need to reconnect
// with the new document name — we kick them so peers get a fresh
// session on the renamed path.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { hasControlChars, loadVisibleNote, visibilityFor } from '@/lib/notes';
import { logAudit } from '@/lib/audit';
import { closeDocumentConnections } from '@/collab/server';
import { assertMoveAllowed } from '@/lib/move-policy';
import { renameNotes } from '@/lib/note-paths';

export const dynamic = 'force-dynamic';

const Body = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024).refine((p) => !hasControlChars(p), 'path must not contain control characters'),
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

  // A note the caller can't see (an editor and a gm_only note) answers
  // exactly like a missing one.
  if (!loadVisibleNote(session.currentGroupId, from, visibilityFor(session.role))) {
    return json({ error: 'not_found' }, 404);
  }

  const result = await renameNotes({
    groupId: session.currentGroupId,
    userId: session.userId,
    moves: [{ from, to }],
  });
  if (!result.ok) {
    return result.error === 'exists'
      ? json({ error: 'exists', path: result.path }, 409)
      : json({ error: 'not_found' }, 404);
  }

  await closeDocumentConnections(session.currentGroupId, from);

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
