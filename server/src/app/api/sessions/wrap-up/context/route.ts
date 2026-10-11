// GET /api/sessions/wrap-up/context?sessionPath=…&limit=…&cursor=…
//
// What a client needs to propose a Wrap-up: the Session log and a page
// of the Notes the caller can see that a mention could land on (path,
// title, kind), each flagged `recorded` when its History already links
// this Session, so a re-run proposes only what is new. Page through
// with `nextCursor` until it is null.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { apiErrorResponse } from '@/lib/analytics/api-error';
import {
  DEFAULT_CANDIDATE_LIMIT,
  MAX_CANDIDATE_LIMIT,
  loadVisibleSession,
  wrapUpContext,
} from '@/lib/wrap-up';

export const dynamic = 'force-dynamic';

const Query = z.object({
  sessionPath: z.string().trim().min(1).max(512),
  limit: z.coerce.number().int().min(1).max(MAX_CANDIDATE_LIMIT).default(DEFAULT_CANDIDATE_LIMIT),
  cursor: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;

    const params = req.nextUrl.searchParams;
    const query = Query.safeParse({
      sessionPath: params.get('sessionPath') ?? undefined,
      limit: params.get('limit') ?? undefined,
      cursor: params.get('cursor') ?? undefined,
    });
    if (!query.success) return json({ error: 'invalid_query' }, 400);

    const lookup = loadVisibleSession(session.currentGroupId, session.role, query.data.sessionPath);
    if (lookup.status === 'not_found') return json({ error: 'not_found' }, 404);
    if (lookup.status === 'not_a_session') return json({ error: 'not_a_session' }, 400);

    return json(
      wrapUpContext({
        groupId: session.currentGroupId,
        role: session.role,
        session: lookup.note,
        limit: query.data.limit,
        cursor: query.data.cursor,
      }),
      200,
    );
  } catch (err) {
    return apiErrorResponse('api/sessions/wrap-up/context', err);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
