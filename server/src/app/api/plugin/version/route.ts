// GET /api/plugin/version — returns the sha256 of the current bundle.
// Any authenticated caller (admin OR player) can check for updates.

import type { NextRequest } from 'next/server';
import { requireRequestAuth } from '@/lib/auth';
import { getPluginBundle } from '@/lib/plugin-bundle';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const { hash } = getPluginBundle();
  return Response.json({ hash });
}
