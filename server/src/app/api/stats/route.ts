// GET /api/stats — admin-only. Dashboard polls this every few seconds.

import type { NextRequest } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { collectStats } from '@/lib/stats';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  return Response.json(collectStats());
}
