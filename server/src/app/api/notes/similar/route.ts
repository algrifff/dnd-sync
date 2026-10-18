// GET /api/notes/similar?name=<text> — Notes the caller can see whose
// title or alias resembles `name`, for the "already exists" warning.
// Read only: session required, no CSRF. Returns { matches } (at most 3).

import type { NextRequest } from 'next/server';
import { similarNotesLimiter } from '@/lib/ratelimit';
import { requireSession } from '@/lib/session';
import { findSimilarNotes } from '@/lib/similar-names';

export const dynamic = 'force-dynamic';

const MAX_NAME = 200;

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const rate = similarNotesLimiter.check(session.userId, false);
  if (!rate.allowed) {
    return Response.json(
      { error: 'rate_limited', retryAfterMs: rate.retryAfterMs },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }
  similarNotesLimiter.recordFailure(session.userId, false);

  const name = req.nextUrl.searchParams.get('name')?.trim() ?? '';
  if (!name || name.length > MAX_NAME) return Response.json({ matches: [] });

  const matches = findSimilarNotes({
    groupId: session.currentGroupId,
    role: session.role,
    name,
  });
  return Response.json({ matches });
}
