// POST /api/import/:id/orchestrate
//
// Kicks off the Smart Import multi-pass orchestrator for a job that
// is in 'uploaded' or 'ready' state. Returns immediately; the worker
// runs in-process in the background. Idempotent — a second call while
// the worker is already running is a no-op.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getImportJob } from '@/lib/imports';
import { startOrchestration, isOrchestrationRunning } from '@/lib/import-orchestrate';

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
  if (job.groupId !== session.currentGroupId) return json({ error: 'not_found' }, 404);
  if (job.createdBy !== session.userId && session.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }
  if (job.status !== 'uploaded' && job.status !== 'ready') {
    return json({ error: 'bad_state', status: job.status }, 409);
  }
  if (!process.env.OPENAI_API_KEY) {
    return json({ error: 'no_api_key', reason: 'OPENAI_API_KEY is not set' }, 503);
  }

  if (!isOrchestrationRunning(id)) {
    startOrchestration(id);
  }

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
