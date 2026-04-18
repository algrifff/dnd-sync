// POST /api/admin/vault/upload — admin-only vault ingest.
//
// Contract:
//   - multipart/form-data with a single `vault` field (the ZIP)
//   - X-CSRF-Token header matches session cookie (double-submit CSRF
//     since Server Actions can't ergonomically handle large multipart
//     bodies)
//   - 500 MB cap via Content-Length; enforced pre-parse
//
// Returns JSON IngestSummary on success.

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { adminUploadLimiter } from '@/lib/ratelimit';
import { ingestZip } from '@/lib/ingest';

export const dynamic = 'force-dynamic';

const UPLOAD_CAP = 500 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const authed = requireAdmin(req);
  if (authed instanceof Response) return authed;

  const csrf = verifyCsrf(req, authed);
  if (csrf) return csrf;

  const rate = adminUploadLimiter.check(authed.userId, false);
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
  } catch {
    return json({ error: 'invalid_multipart' }, 400);
  }

  const vault = form.get('vault');
  if (!(vault instanceof Blob) || vault.size === 0) {
    return json({ error: 'missing_field', field: 'vault' }, 400);
  }
  if (vault.size > UPLOAD_CAP) {
    return json({ error: 'payload_too_large', maxBytes: UPLOAD_CAP }, 413);
  }

  // Write the blob to /data/tmp so adm-zip can open by path rather
  // than forcing us to hold it all in memory (node-adm-zip has a
  // Buffer constructor but the file-path path is friendlier for larger
  // archives).
  const tmpDir = resolve(process.env.DATA_DIR ?? './.data', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `upload-${randomUUID()}.zip`);
  const bytes = new Uint8Array(await vault.arrayBuffer());
  writeFileSync(tmpPath, bytes);

  try {
    const summary = await ingestZip({
      zipPath: tmpPath,
      groupId: authed.currentGroupId,
      actorId: authed.userId,
    });
    adminUploadLimiter.recordSuccess(authed.userId);
    return json({ ok: true, summary }, 200);
  } catch (err) {
    adminUploadLimiter.recordFailure(authed.userId, false);
    console.error('[vault.upload] ingest failed:', err);
    return json(
      {
        error: 'ingest_failed',
        message: err instanceof Error ? err.message : 'unknown',
      },
      500,
    );
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}
