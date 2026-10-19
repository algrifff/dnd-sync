// /api/sessions/wrap-up — the Session's pending Wrap-up proposal.
//
// GET  ?sessionPath=…  { proposal, existingTitles, similar }: the pending
//                      proposal (null when none is waiting for review),
//                      the titles of the Notes its existing matches name,
//                      and per new-Note mention id the visible Notes with
//                      a close name it could use instead.
// POST { sessionPath, mentions, relations?, suggestions? }
//                      Submit a proposal (a Player's Claude calls this).
//                      Replaces any earlier pending proposal. Any role
//                      that can see the Session may submit; a mention,
//                      Relationship end or Suggestion naming a Note the
//                      caller cannot see is a 404. Suggestions are
//                      { characterPath, story, items: [{ name, quantity }] },
//                      at most one per Character.
//                      Relationships are { from, relation, to, note? },
//                      each end { type: 'mention', name } (a mention of
//                      this proposal) or { type: 'existing', path };
//                      one that cannot be resolved is 400 invalid_relation.
//
// lib/wrap-up.ts owns the schema, the Session gate and every check; this
// route maps its result onto HTTP.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { apiErrorResponse } from '@/lib/analytics/api-error';
import { readWrapUpReview, submitWrapUp } from '@/lib/wrap-up';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;

    const sessionPath = req.nextUrl.searchParams.get('sessionPath')?.trim() ?? '';
    if (!sessionPath || sessionPath.length > 512) return json({ error: 'invalid_body' }, 400);

    const review = readWrapUpReview({ groupId: session.currentGroupId, role: session.role, sessionPath });
    switch (review.status) {
      case 'not_found':
        return json({ error: 'not_found' }, 404);
      case 'not_a_session':
        return json({ error: 'not_a_session' }, 400);
      case 'ok':
        return json(
          { proposal: review.proposal, existingTitles: review.existingTitles, similar: review.similar },
          200,
        );
    }
  } catch (err) {
    return apiErrorResponse('api/sessions/wrap-up', err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;
    const csrf = verifyCsrf(req, session);
    if (csrf) return csrf;

    let submission: unknown;
    try {
      submission = await req.json();
    } catch {
      return json({ error: 'invalid_body', reason: 'body is not valid JSON' }, 400);
    }

    const result = submitWrapUp({ groupId: session.currentGroupId, role: session.role, submission });
    switch (result.status) {
      case 'not_found':
        return json({ error: 'not_found' }, 404);
      case 'not_a_session':
        return json({ error: 'not_a_session' }, 400);
      case 'invalid_body':
        return json({ error: 'invalid_body', reason: result.reason }, 400);
      case 'invalid_target':
        return json({ error: 'invalid_mention_target', reason: result.reason }, 400);
      case 'invalid_suggestion_target':
        return json({ error: 'invalid_suggestion_target', reason: result.reason }, 400);
      case 'invalid_relation':
        return json({ error: 'invalid_relation', reason: result.reason }, 400);
      case 'ok':
        return json({ ok: true, proposal: result.proposal }, 201);
    }
  } catch (err) {
    return apiErrorResponse('api/sessions/wrap-up', err);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
