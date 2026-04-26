// POST /api/folders/move — rename or reparent a folder (and everything
// in it). Thin wrapper around the shared moveFolder() lib in
// server/src/lib/move-folder.ts; this route enforces the drag-and-drop
// move policy (canonical subfolders / campaign roots / PCs are locked)
// and delegates the actual data move + wikilink rewrite to the lib.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { logAudit } from '@/lib/audit';
import { assertMoveAllowed } from '@/lib/move-policy';
import { moveFolder } from '@/lib/move-folder';

export const dynamic = 'force-dynamic';

const Body = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot rename folders' }, 403);
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

  const policy = assertMoveAllowed({ kind: 'folder', from, to });
  if (!policy.ok) return json({ error: policy.error, reason: policy.reason }, 403);

  const result = await moveFolder({
    groupId: session.currentGroupId,
    userId: session.userId,
    from,
    to,
  });
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : result.error === 'exists' ? 409 : 400;
    return json({ error: result.error, ...(result.path ? { path: result.path } : {}) }, status);
  }

  logAudit({
    action: 'folder.rename',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: `${from} -> ${to}`,
  });

  return json({ ok: true, path: to, moved: result.movedCount });
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
