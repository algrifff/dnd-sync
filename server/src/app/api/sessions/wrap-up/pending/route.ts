// GET /api/sessions/wrap-up/pending — the Sessions in the current World
// with a Wrap-up proposal waiting for review that the caller may see:
// { pending: [{ sessionPath, title, generatedAt, mentions, relations,
// suggestions }] }, newest first. Polled by the header's Wrap-up notice.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { apiErrorResponse } from '@/lib/analytics/api-error';
import { listPendingWrapUps } from '@/lib/wrap-up';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = requireSession(req);
    if (session instanceof Response) return session;
    const pending = listPendingWrapUps(session.currentGroupId, session.role);
    return new Response(JSON.stringify({ pending }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return apiErrorResponse('api/sessions/wrap-up/pending', err);
  }
}
