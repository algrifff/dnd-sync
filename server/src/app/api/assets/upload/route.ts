// POST /api/assets/upload — multipart upload of a single asset.
// requireSession + verifyCsrf + rate limit (30/min/user). Returns
// { id, mime, size, originalName }.
//
// We read the whole blob into memory because the cap is 100 MB per
// file — feasible for Railway's memory budget, and simpler than
// plumbing a streaming hash + temp file right now. Phase-8 polish
// can switch to streaming once the editor UX is stable.

import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { assetUploadLimiter } from '@/lib/ratelimit';
import { storeAssetFromBuffer } from '@/lib/assets';
import { logAudit } from '@/lib/audit';
import { GM_MODE_COOKIE, isGmModeOn } from '@/lib/gm-mode';

export const dynamic = 'force-dynamic';

const PER_FILE_CAP = 100 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const rate = assetUploadLimiter.check(session.userId, false);
  if (!rate.allowed) {
    return json(
      { error: 'rate_limited', retryAfterMs: rate.retryAfterMs },
      429,
      { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) },
    );
  }

  const clen = Number(req.headers.get('content-length') ?? 0);
  if (clen > PER_FILE_CAP + 4096) {
    return json({ error: 'payload_too_large', maxBytes: PER_FILE_CAP }, 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'invalid_multipart' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof Blob) || file.size === 0) {
    return json({ error: 'missing_field', field: 'file' }, 400);
  }
  if (file.size > PER_FILE_CAP) {
    return json({ error: 'payload_too_large', maxBytes: PER_FILE_CAP }, 413);
  }

  const name = fileName(file);
  const buf = new Uint8Array(await file.arrayBuffer());

  try {
    const jar = await cookies();
    const gmOnly = isGmModeOn(jar.get(GM_MODE_COOKIE)?.value, session.role);
    const stored = storeAssetFromBuffer(
      buf,
      name,
      session.currentGroupId,
      session.userId,
      { gmOnly },
    );
    assetUploadLimiter.recordSuccess(session.userId);
    logAudit({
      action: 'asset.upload',
      actorId: session.userId,
      groupId: session.currentGroupId,
      target: stored.id,
      details: {
        mime: stored.mime,
        size: stored.size,
        originalName: stored.originalName,
        reused: stored.reused,
      },
    });
    return json({
      ok: true,
      id: stored.id,
      mime: stored.mime,
      size: stored.size,
      originalName: stored.originalName,
      reused: stored.reused,
    });
  } catch (err) {
    assetUploadLimiter.recordFailure(session.userId, false);
    return json(
      { error: 'upload_rejected', message: err instanceof Error ? err.message : 'unknown' },
      400,
    );
  }
}

function fileName(file: Blob | File): string {
  if (file instanceof File && file.name) return file.name.slice(0, 200);
  return 'upload.bin';
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}
