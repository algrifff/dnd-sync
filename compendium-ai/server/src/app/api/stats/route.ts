// GET /api/stats — admin-only. Dashboard polls this every few seconds.

import type { NextRequest } from 'next/server';
import { requireRequestAuth } from '@/lib/auth';
import { collectStats } from '@/lib/stats';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;
  if (auth !== 'admin') {
    return new Response(JSON.stringify({ error: 'admin only' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return Response.json(collectStats());
}
