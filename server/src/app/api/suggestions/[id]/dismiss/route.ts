// POST /api/suggestions/:id/dismiss — drop the Suggestion and leave the
// Character as it is. Dismissing again changes nothing. Only the
// Character's Player can, from whichever World is current: anyone else
// gets 404. 409 already_accepted.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { apiErrorResponse } from '@/lib/analytics/api-error';
import { dismissSuggestion } from '@/lib/character-suggestions';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;
    const csrf = verifyCsrf(req, session);
    if (csrf) return csrf;

    const { id } = await ctx.params;
    const result = dismissSuggestion({ userId: session.userId, id });
    switch (result.status) {
      case 'not_found':
        return json({ error: 'not_found' }, 404);
      case 'conflict':
        return json({ error: `already_${result.resolved}` }, 409);
      case 'ok':
        return json({ ok: true, changed: result.changed }, 200);
    }
  } catch (err) {
    return apiErrorResponse('api/suggestions/dismiss', err);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
