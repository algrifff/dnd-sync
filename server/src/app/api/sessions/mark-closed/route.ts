// POST /api/sessions/mark-closed — close a Session without a Wrap-up
// ("Close without a Wrap-up" in the End of Session dialog). Drops any
// pending proposal, exactly as applying one does; to apply a proposal
// use /api/sessions/wrap-up/apply instead.
//
// Body: { sessionPath: string }
//
// 404 for a Session the caller cannot see or that does not exist, 400
// not_a_session for any other Note. lib/wrap-up.ts#endSession owns both.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { endSession } from '@/lib/wrap-up';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';
import { apiErrorResponse } from '@/lib/analytics/api-error';

export const dynamic = 'force-dynamic';

const Body = z.object({
  sessionPath: z.string().min(1).max(512),
});

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;
    const csrf = verifyCsrf(req, session);
    if (csrf) return csrf;

    let body: z.infer<typeof Body>;
    try {
      body = Body.parse(await req.json());
    } catch {
      return json({ error: 'invalid_body' }, 400);
    }

    const result = endSession({
      groupId: session.currentGroupId,
      userId: session.userId,
      role: session.role,
      sessionPath: body.sessionPath,
    });
    if (result.status === 'not_found') return json({ error: 'not_found' }, 404);
    if (result.status === 'not_a_session') {
      return json({ error: 'not_a_session', reason: 'note is not a session kind' }, 400);
    }

    void captureServer({
      userId: session.userId,
      groupId: session.currentGroupId,
      event: EVENTS.SESSION_CLOSED,
      properties: {
        session_path: body.sessionPath,
        campaign_slug: body.sessionPath.split('/')[1] ?? null,
      },
    });

    return json({ ok: true }, 200);
  } catch (err) {
    return apiErrorResponse('api/sessions/mark-closed', err);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
