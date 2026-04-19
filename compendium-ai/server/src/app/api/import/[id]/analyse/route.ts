// POST /api/import/:id/analyse — kick off (or resume) the background
// AI classifier for this job. Returns 202 immediately; the client
// polls GET /api/import/:id for progress.
//
// Idempotent: if the worker is already running for this job id, the
// endpoint simply returns the current status.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getImportJob } from '@/lib/imports';
import {
  isAnalyseRunning,
  runAnalyseInBackground,
} from '@/lib/import-analyse';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const job = getImportJob(id);
  if (!job) return json({ error: 'not_found' }, 404);
  if (job.groupId !== session.currentGroupId) {
    return json({ error: 'not_found' }, 404);
  }
  if (job.createdBy !== session.userId && session.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }
  if (!process.env.OPENAI_API_KEY) {
    return json(
      { error: 'openai_not_configured', detail: 'OPENAI_API_KEY is not set on the server' },
      503,
    );
  }

  if (job.status === 'applied') {
    return json({ error: 'already_applied' }, 409);
  }
  if (job.status === 'cancelled') {
    return json({ error: 'cancelled' }, 409);
  }

  if (!isAnalyseRunning(id)) {
    runAnalyseInBackground(id);
  }

  return json({ ok: true, running: true }, 202);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
