// GET /api/health — liveness probe for Railway and the installer sanity check.

import { LATEST_SCHEMA_VERSION } from '@/lib/migrations';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    ok: true,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    schemaVersion: LATEST_SCHEMA_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
