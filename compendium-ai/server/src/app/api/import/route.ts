// POST /api/import — upload a ZIP to start a new AI-assisted import
// job. The classical parse + AI analyse + apply steps land in their
// own endpoints (phases 1b–1e); this one only persists the bytes and
// creates the job row in status='uploaded'.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { adminUploadLimiter } from '@/lib/ratelimit';
import {
  createImportJob,
  listOpenJobsForUser,
  updateImportJob,
  writeJobZip,
} from '@/lib/imports';
import { parseImportZip } from '@/lib/import-parse';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const UPLOAD_CAP = 500 * 1024 * 1024;

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  // Surface any in-flight jobs for the home-page resumable banner.
  return json({
    jobs: listOpenJobsForUser(session.currentGroupId, session.userId),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    return await handleUpload(req);
  } catch (err) {
    console.error('[import.upload] unhandled:', err);
    return json(
      {
        error: 'unhandled',
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}

async function handleUpload(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot import' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  // Reuse the admin-upload rate limiter: same user, same blast radius,
  // same reason to keep it throttled. If a dedicated bucket is wanted
  // later we can split.
  const rate = adminUploadLimiter.check(session.userId, false);
  if (!rate.allowed) {
    return json(
      { error: 'rate_limited', retryAfterMs: rate.retryAfterMs },
      429,
      { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) },
    );
  }

  const clen = Number(req.headers.get('content-length') ?? 0);
  if (clen > UPLOAD_CAP) {
    return json({ error: 'payload_too_large', maxBytes: UPLOAD_CAP }, 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return json(
      { error: 'invalid_multipart', message: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const file = form.get('file');
  if (!(file instanceof Blob) || file.size === 0) {
    return json({ error: 'missing_field', field: 'file' }, 400);
  }
  if (file.size > UPLOAD_CAP) {
    return json({ error: 'payload_too_large', maxBytes: UPLOAD_CAP }, 413);
  }

  // Pre-allocate the job id so we can name the blob after it.
  const jobId = randomUUID();
  let tmpPath: string;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    tmpPath = writeJobZip(jobId, bytes);
  } catch (err) {
    adminUploadLimiter.recordFailure(session.userId, false);
    return json(
      {
        error: 'tmp_write_failed',
        message: err instanceof Error ? err.message : 'unknown',
      },
      500,
    );
  }

  // We chose `createImportJob` over manual SQL so the helper keeps
  // the status machine canonical. It generates its own id, which we
  // discard by passing the pre-allocated one indirectly: the row
  // records our tmpPath, and since tmpPath is named `<jobId>.zip`,
  // the two stay aligned operationally even without a FK on id.
  // (Callers downstream never need the file-system id; they use the
  // row id.)
  let job = createImportJob({
    groupId: session.currentGroupId,
    createdBy: session.userId,
    rawZipPath: tmpPath,
  });
  adminUploadLimiter.recordSuccess(session.userId);

  // Classical parse pass runs inline. Fast enough that the chat can
  // show the parsed totals without waiting for the async analyse
  // step. Failures drop the job into 'failed' so the client can
  // surface the reason without the server hanging.
  try {
    const plan = parseImportZip(tmpPath);
    updateImportJob(job.id, { plan, status: 'uploaded' });
    job = {
      ...job,
      plan,
    };
  } catch (err) {
    updateImportJob(job.id, {
      status: 'failed',
      stats: {
        parseError: err instanceof Error ? err.message : String(err),
      },
    });
    return json(
      {
        error: 'parse_failed',
        jobId: job.id,
        message: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }

  // Consumer-friendly shape for the chat UI: return the just-created
  // job + the same shape /api/import/:id will return on poll.
  return json(
    {
      ok: true,
      job,
      filename: file instanceof File ? file.name : null,
      size: file.size,
    },
    201,
  );
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}
