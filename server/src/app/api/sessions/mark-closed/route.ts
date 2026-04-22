// POST /api/sessions/mark-closed — mark a session note as closed.
// Lightweight — no AI, no entity work. Just flips the status flag so the
// End of Session button can close the session before handing off to chat.
//
// Body: { sessionPath: string }

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  sessionPath: z.string().min(1).max(512),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO session_notes (group_id, note_path, updated_at, status, closed_at, closed_by)
       VALUES (?, ?, ?, 'closed', ?, ?)
       ON CONFLICT (group_id, note_path)
       DO UPDATE SET status='closed', closed_at=excluded.closed_at, closed_by=excluded.closed_by`,
    )
    .run(session.currentGroupId, body.sessionPath, now, now, session.userId);

  return json({ ok: true }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
