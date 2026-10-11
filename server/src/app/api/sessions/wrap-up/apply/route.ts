// POST /api/sessions/wrap-up/apply — apply the closer's decisions on
// the Session's pending proposal, then close the Session.
//
// Body: { sessionPath, accepted: mention ids, asNew: accepted ids whose
// uncertain match the closer switched to a new Note }
//
// 409 no_pending_proposal when there is nothing to apply, which is also
// what a repeated apply gets: the first one cleared the proposal, so
// the second changes nothing. To close a Session without a proposal use
// /api/sessions/mark-closed.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';
import { apiErrorResponse } from '@/lib/analytics/api-error';
import { applyWrapUp, loadPendingWrapUp, loadVisibleSession } from '@/lib/wrap-up';

export const dynamic = 'force-dynamic';

const Body = z.object({
  sessionPath: z.string().min(1).max(512),
  accepted: z.array(z.string().min(1).max(64)).max(200),
  asNew: z.array(z.string().min(1).max(64)).max(200).default([]),
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

    const { currentGroupId: groupId, role, userId } = session;
    const lookup = loadVisibleSession(groupId, role, body.sessionPath);
    if (lookup.status === 'not_found') return json({ error: 'not_found' }, 404);
    if (lookup.status === 'not_a_session') return json({ error: 'not_a_session' }, 400);

    const proposal = loadPendingWrapUp(groupId, role, body.sessionPath);
    if (!proposal) return json({ error: 'no_pending_proposal' }, 409);

    const result = await applyWrapUp({
      groupId,
      userId,
      role,
      sessionPath: body.sessionPath,
      proposal,
      decisions: { accepted: body.accepted, asNew: body.asNew },
    });

    void captureServer({
      userId,
      groupId,
      event: EVENTS.SESSION_CLOSED,
      properties: {
        session_path: body.sessionPath,
        campaign_slug: body.sessionPath.split('/')[1] ?? null,
        applied: result.applied.length,
        created: result.applied.filter((a) => a.created).length,
      },
    });

    return json({ ok: true, ...result }, 200);
  } catch (err) {
    return apiErrorResponse('api/sessions/wrap-up/apply', err);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
