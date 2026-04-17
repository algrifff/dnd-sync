// GET /api/health — liveness probe for Railway and the installer sanity check.

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    ok: true,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    startedAt: process.env.COMPENDIUM_STARTED_AT ?? null,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
