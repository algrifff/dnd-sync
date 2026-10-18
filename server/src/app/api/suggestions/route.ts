// GET /api/suggestions — the current user's pending Suggestions: what
// Wrap-ups have offered their Characters, waiting for them to accept
// or dismiss, from every World they belong to, each gated by their role
// in its own World. Someone else's Suggestions are never listed.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { apiErrorResponse } from '@/lib/analytics/api-error';
import { listMySuggestions } from '@/lib/character-suggestions';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;

    const suggestions = listMySuggestions({ userId: session.userId });
    return json({ suggestions }, 200);
  } catch (err) {
    return apiErrorResponse('api/suggestions', err);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
