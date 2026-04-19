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
import { closeDocumentConnections } from '@/collab/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const UPLOAD_CAP = 500 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  // Outer safety net: no matter where a throw happens, respond with JSON
  // (including the stack head) so the client shows the real cause rather
  // than Next's generic HTML 500 page.
  try {
    return await handleUpload(req);
  } catch (err) {
    console.error('[vault.upload] unhandled:', err);
    return json(
      {
        error: 'unhandled',
        message: err instanceof Error ? err.message : String(err),
        stack:
          err instanceof Error
            ? (err.stack ?? '').split('\n').slice(0, 5).join('\n')
            : undefined,
      },
      500,
    );
  }
}

async function handleUpload(req: NextRequest): Promise<Response> {
  console.log('[vault.upload] step=start');
  const authed = requireAdmin(req);
  if (authed instanceof Response) return authed;
  console.log('[vault.upload] step=authed user=' + authed.userId);

  const csrf = verifyCsrf(req, authed);
  if (csrf) return csrf;
  console.log('[vault.upload] step=csrf-ok');

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
  } catch (err) {
    console.error('[vault.upload] step=formdata-failed:', err);
    return json(
      {
        error: 'invalid_multipart',
        message: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }
  console.log('[vault.upload] step=formdata-ok');

  const vault = form.get('vault');
  if (!(vault instanceof Blob) || vault.size === 0) {
    return json({ error: 'missing_field', field: 'vault' }, 400);
  }
  if (vault.size > UPLOAD_CAP) {
    return json({ error: 'payload_too_large', maxBytes: UPLOAD_CAP }, 413);
  }
  console.log('[vault.upload] step=blob-ok size=' + vault.size);

  // Write the blob to $DATA_DIR/tmp so adm-zip can open by path rather
  // than forcing us to hold it all in memory. Wrap setup in the same
  // try/catch as the ingest itself so any EACCES on the volume mount
  // surfaces as structured JSON instead of Next's generic HTML 500.
  const tmpDir = resolve(process.env.DATA_DIR ?? './.data', 'tmp');
  let tmpPath = '';
  try {
    mkdirSync(tmpDir, { recursive: true });
    tmpPath = join(tmpDir, `upload-${randomUUID()}.zip`);
    const bytes = new Uint8Array(await vault.arrayBuffer());
    writeFileSync(tmpPath, bytes);
    console.log('[vault.upload] step=tmp-written path=' + tmpPath);
  } catch (err) {
    adminUploadLimiter.recordFailure(authed.userId, false);
    console.error('[vault.upload] tmp write failed:', err);
    return json(
      {
        error: 'tmp_write_failed',
        message: err instanceof Error ? err.message : 'unknown',
        tmpDir,
      },
      500,
    );
  }

  // Snapshot every currently-stored path BEFORE ingest so we can
  // disconnect live editors on anything the ingest touches.
  const beforePaths = getDb()
    .query<{ path: string }, [string]>('SELECT path FROM notes WHERE group_id = ?')
    .all(authed.currentGroupId)
    .map((r) => r.path);

  try {
    console.log('[vault.upload] step=ingest-start');
    const summary = await ingestZip({
      zipPath: tmpPath,
      groupId: authed.currentGroupId,
      actorId: authed.userId,
    });
    console.log('[vault.upload] step=ingest-ok notes=' + summary.notes);
    adminUploadLimiter.recordSuccess(authed.userId);

    // Kick any live editors on paths that existed before so they
    // reconnect and load the fresh server state rather than fighting
    // it with their in-memory doc.
    await Promise.all(beforePaths.map((p) => closeDocumentConnections(p)));

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
      if (tmpPath) rmSync(tmpPath, { force: true });
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
