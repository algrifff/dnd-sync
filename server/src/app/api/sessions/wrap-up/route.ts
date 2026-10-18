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
//                      { characterPath, story, items: [{ name, quantity }] }.
//                      Relationships are { from, relation, to, note? },
//                      each end { type: 'mention', name } (a mention of
//                      this proposal) or { type: 'existing', path };
//                      one that cannot be resolved is 400 invalid_relation.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { apiErrorResponse } from '@/lib/analytics/api-error';
import {
  describeRelationProblem,
  existingTitles,
  loadPendingWrapUp,
  loadVisibleSession,
  similarNotesFor,
  submitWrapUp,
  WrapUpSubmission,
} from '@/lib/wrap-up';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;

    const sessionPath = req.nextUrl.searchParams.get('sessionPath')?.trim() ?? '';
    if (!sessionPath || sessionPath.length > 512) return json({ error: 'invalid_body' }, 400);

    const lookup = loadVisibleSession(session.currentGroupId, session.role, sessionPath);
    if (lookup.status === 'not_found') return json({ error: 'not_found' }, 404);
    if (lookup.status === 'not_a_session') return json({ error: 'not_a_session' }, 400);

    const proposal = loadPendingWrapUp(session.currentGroupId, session.role, sessionPath);
    if (!proposal) return json({ proposal, existingTitles: {}, similar: {} }, 200);
    const similar = similarNotesFor(session.currentGroupId, session.role, proposal);
    return json({ proposal, existingTitles: existingTitles(session.currentGroupId, proposal), similar }, 200);
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

    let submission: WrapUpSubmission;
    try {
      submission = WrapUpSubmission.parse(await req.json());
    } catch (err) {
      return json({ error: 'invalid_body', reason: describeInvalid(err) }, 400);
    }

    const result = submitWrapUp({
      groupId: session.currentGroupId,
      role: session.role,
      submission,
    });
    switch (result.status) {
      case 'not_found':
        return json({ error: 'not_found' }, 404);
      case 'not_a_session':
        return json({ error: 'not_a_session' }, 400);
      case 'invalid_target':
        return json(
          { error: 'invalid_mention_target', reason: `"${result.mention}" must match a Person, Creature, Location, Item, Quest or Lore Note` },
          400,
        );
      case 'invalid_suggestion_target':
        return json(
          { error: 'invalid_suggestion_target', reason: `"${result.characterPath}" must be a Character Note` },
          400,
        );
      case 'invalid_relation':
        return json(
          { error: 'invalid_relation', reason: describeRelationProblem(result.index, result.problem) },
          400,
        );
      case 'ok':
        return json({ ok: true, proposal: result.proposal }, 201);
    }
  } catch (err) {
    return apiErrorResponse('api/sessions/wrap-up', err);
  }
}

/** First Zod issue as `path: message`, so a client can fix its payload
 *  without the stack or the schema internals. */
function describeInvalid(err: unknown): string {
  const issue = (err as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues?.[0];
  return issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'body is not valid JSON';
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
