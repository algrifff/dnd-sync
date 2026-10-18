// POST /api/suggestions/:id/accept — add the Suggestion to the Character: a
// History entry for its story and its items in the inventory. Never
// stats. Accepting again changes nothing. Only the Character's Player
// can, from whichever World is current: the Suggestion's own World and
// their role there decide. Anyone else gets 404, as does a hidden
// Character or Session, or a World they have left.
// 409 already_dismissed / invalid_sheet / edit_failed.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { apiErrorResponse } from '@/lib/analytics/api-error';
import { acceptSuggestion } from '@/lib/character-suggestions';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;
    const csrf = verifyCsrf(req, session);
    if (csrf) return csrf;

    const { id } = await ctx.params;
    const result = await acceptSuggestion({ userId: session.userId, id });
    switch (result.status) {
      case 'not_found':
        return json({ error: 'not_found' }, 404);
      case 'conflict':
        return json({ error: `already_${result.resolved}` }, 409);
      case 'invalid_sheet':
        return json({ error: 'invalid_sheet', reason: 'The Character Sheet is not valid, so the items could not be added.' }, 409);
      case 'edit_failed':
        return json({ error: 'edit_failed', reason: 'The Character Note could not take the History entry.' }, 409);
      case 'ok':
        return json({ ok: true, changed: result.changed }, 200);
    }
  } catch (err) {
    return apiErrorResponse('api/suggestions/accept', err);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
