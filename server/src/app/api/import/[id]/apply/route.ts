// POST /api/import/:id/apply — commit the job's accepted plan to the
// vault. Runs the apply pipeline synchronously and returns the
// summary. On success the job status flips to 'applied' and the
// temp ZIP is deleted; on any single-note failure the rest of the
// batch still lands and the error is recorded in stats.errors.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getImportJob, updateImportJob } from '@/lib/imports';
import { applyImportJob } from '@/lib/import-apply';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

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
  if (job.status !== 'ready' && job.status !== 'uploaded') {
    return json({ error: 'bad_state', status: job.status }, 409);
  }

  const startedAt = Date.now();
  try {
    const summary = await applyImportJob(id);
    void captureServer({
      userId: session.userId,
      groupId: session.currentGroupId,
      event: EVENTS.IMPORT_APPLIED,
      properties: {
        job_id: id,
        moved: summary.moved,
        merged: summary.merged,
        kept_in_place: summary.keptInPlace,
        failed: summary.failed,
        assets_committed: summary.assetsCommitted,
        error_count: summary.errors.length,
        duration_ms: Date.now() - startedAt,
      },
    });
    return json(
      {
        ok: true,
        moved: summary.moved,
        merged: summary.merged,
        keptInPlace: summary.keptInPlace,
        failed: summary.failed,
        assetsCommitted: summary.assetsCommitted,
        errors: summary.errors,
      },
      200,
    );
  } catch (err) {
    updateImportJob(id, {
      status: 'failed',
      stats: {
        applyError: err instanceof Error ? err.message : String(err),
      },
    });
    void captureServer({
      userId: session.userId,
      groupId: session.currentGroupId,
      event: EVENTS.IMPORT_FAILED,
      properties: {
        job_id: id,
        stage: 'apply',
        message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        duration_ms: Date.now() - startedAt,
      },
    });
    return json(
      {
        error: 'apply_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
