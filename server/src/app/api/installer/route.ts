// Admin endpoints for installer-key management.
//
//   GET  /api/installer            → returns the current key (for the dashboard)
//   POST /api/installer/rotate     → rotates the key and returns the new one

import type { NextRequest } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { getConfigValue, regenerateConfigValue } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  return Response.json({ installerKey: getConfigValue('installer_key') });
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  const fresh = regenerateConfigValue('installer_key');
  return Response.json({ installerKey: fresh });
}
