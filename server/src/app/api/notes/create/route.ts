// POST /api/notes/create — create an empty note at the given path.
// Body: { folder: string, name: string }  (name does NOT need .md;
// the server appends it). Returns 201 { path }.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { canonicalKind, KIND_INPUTS } from '@compendium/shared';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { logAudit } from '@/lib/audit';
import { createNote } from '@/lib/create-note';
import { isAllowedPath, visibilityFor } from '@/lib/notes';
import { GM_MODE_COOKIE, isGmModeOn } from '@/lib/gm-mode';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

export const dynamic = 'force-dynamic';

const Body = z.object({
  folder: z.string().max(512),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\\0]+$/, 'name must not contain slashes or null bytes'),
  /** Optional entry kind (canonical or legacy alias) — when set, we
   *  pre-seed frontmatter from the matching template so the sheet UI
   *  has defaults to render. "page" (or omitted) creates a plain note
   *  with no kind. */
  kind: z.enum([...KIND_INPUTS, 'page', 'excalidraw']).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    const body = await req.json();
    parsed = Body.parse(body);
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const requestedKind = parsed.kind ?? 'page';

  // GM mode is admin-only. When the cookie is set on an admin's
  // request, the new note lands in the GM namespace (gm_only=1) and
  // is invisible to players until promoted via /api/notes/promote.
  const gmOnly = isGmModeOn(req.cookies.get(GM_MODE_COOKIE)?.value, session.role);

  // Viewers can create plain pages and quests (their own creator-owned
  // notes) and their own Characters; everything else is an admin/editor
  // action.
  if (
    session.role === 'viewer' &&
    requestedKind !== 'page' &&
    requestedKind !== 'excalidraw' &&
    canonicalKind(requestedKind) !== 'quest' &&
    canonicalKind(requestedKind) !== 'character'
  ) {
    return json({ error: 'forbidden', reason: 'players can create pages, quests or PCs only' }, 403);
  }

  const folder = parsed.folder.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (folder.split('/').some((p) => p === '..' || p === '.')) {
    return json({ error: 'invalid_folder' }, 400);
  }
  const baseName = parsed.name.trim().replace(/\.(md|canvas)$/i, '');
  if (!baseName) return json({ error: 'invalid_name' }, 400);
  const basePath = (folder ? folder + '/' : '') + baseName + '.md';

  // Enforce top-level allow-list + no-hidden-segment invariants.
  // Checked against the folder + basename (without the .md suffix) so
  // `.secret.md` and `Random/thing.md` both fail here rather than
  // sneaking in via the note endpoint.
  const allowed = isAllowedPath(folder ? folder + '/' + baseName : baseName);
  if (!allowed.ok) {
    const code = allowed.reason === 'names cannot start with a dot' ? 'invalid_name' : 'forbidden';
    const status = code === 'invalid_name' ? 400 : 403;
    return json({ error: code, reason: allowed.reason }, status);
  }

  // A path held by a note the caller can't see must not answer 409
  // (that would confirm the hidden note exists) and must not touch it,
  // so that case takes the next free " (2)", " (3)" ... name instead,
  // like a duplicate does. A path held by a visible note is still 409.
  const created = await createNote(session.currentGroupId, {
    userId: session.userId,
    username: session.username,
    path: basePath,
    kind: requestedKind,
    title: baseName,
    gmOnly,
    onTaken: 'next-free',
    visibleTo: visibilityFor(session.role),
    suffixTitle: true,
  });
  if (created.status === 'exists') return json({ error: 'exists', path: created.path }, 409);
  const path = created.path;

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
    details: { kind: requestedKind },
  });

  void captureServer({
    userId: session.userId,
    groupId: session.currentGroupId,
    event: EVENTS.NOTE_CREATED,
    properties: {
      kind: requestedKind,
      path_depth: path.split('/').length,
      top_level: path.split('/')[0],
      via: 'ui',
    },
  });

  return json({ ok: true, path }, 201);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
