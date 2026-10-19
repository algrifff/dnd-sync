// POST /api/notes/duplicate — clone an existing note to a new path.
// Body: { path }. Auto-picks "<name> (copy).md", incrementing the
// suffix on conflict. lib/note-paths#copyNote copies the body and
// yjs_state bytewise, the outgoing links and tags, and derives the new
// note's indexes. Aliases and Relationships stay with the original.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { isHiddenFrom, visibilityFor } from '@/lib/notes';
import { nextFreePath } from '@/lib/create-note';
import { copyNote } from '@/lib/note-paths';

export const dynamic = 'force-dynamic';

const Body = z.object({ path: z.string().min(1).max(512) });

type NoteRow = {
  path: string;
  title: string;
  dm_only: number;
  gm_only: number;
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
      `SELECT path, title, dm_only, gm_only FROM notes WHERE group_id = ? AND path = ?`,
    )
    .get(session.currentGroupId, body.path);
  // A note the caller can't see answers exactly like a missing one.
  if (!src || isHiddenFrom(src, visibilityFor(session.role))) {
    return json({ error: 'not_found' }, 404);
  }

  // nextFreePath() scans via SELECT for a free "<name> (copy N)"
  // path, but that scan and the copy below aren't atomic — a second
  // concurrent duplicate of the same source note can land on the same
  // candidate in between. Rather than trust the scan, attempt the copy
  // and, on a lost race, rescan and retry with the next candidate.
  // Bounded so a pathological storm of concurrent requests still
  // terminates in a clean 409 rather than retrying forever.
  const MAX_ATTEMPTS = 5;
  let newPath = nextFreePath(session.currentGroupId, body.path, copySuffix, 1);
  for (let attempt = 1; ; attempt++) {
    const copied = await copyNote({
      groupId: session.currentGroupId,
      userId: session.userId,
      from: src.path,
      to: newPath,
      title: deriveTitle(src.title, newPath),
    });
    if (copied.ok) break;
    if (copied.error === 'not_found') return json({ error: 'not_found' }, 404);
    if (attempt >= MAX_ATTEMPTS) return json({ error: 'exists', path: newPath }, 409);
    newPath = nextFreePath(session.currentGroupId, body.path, copySuffix, 1);
  }

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: newPath,
    details: { duplicatedFrom: src.path },
  });

  return json({ ok: true, path: newPath }, 201);
}

const copySuffix = (n: number): string => (n === 1 ? ' (copy)' : ` (copy ${n})`);

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
