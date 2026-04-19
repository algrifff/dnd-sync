// POST /api/profile/avatar  — upload self's avatar image.
// DELETE /api/profile/avatar — clear self's avatar.
//
// Accepts the resized image bytes the client already shrunk in the
// browser via canvas (~128 px, ≤ ~50 kB). This endpoint does NOT
// re-encode — the server isn't the right place to pull in image
// tooling for a hobby app — so it trusts the size/mime it gets and
// just validates loosely. Worst case a user uploads a big image and
// wastes their own DB row; they see it in their own browser so
// they'll notice.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { clearUserAvatar, setUserAvatar } from '@/lib/users';

export const dynamic = 'force-dynamic';

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BYTES = 512 * 1024; // 512 kB — generous for a ≤ 128 px image

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const mime = req.headers.get('content-type') ?? '';
  if (!ALLOWED_MIMES.has(mime)) {
    return json({ error: 'unsupported_mime', detail: mime }, 415);
  }

  const arrayBuffer = await req.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    return json({ error: 'empty_body' }, 400);
  }
  if (arrayBuffer.byteLength > MAX_BYTES) {
    return json({ error: 'too_large', detail: `max ${MAX_BYTES} bytes` }, 413);
  }

  const updatedAt = setUserAvatar(
    session.userId,
    new Uint8Array(arrayBuffer),
    mime,
  );
  return json({ ok: true, avatarVersion: updatedAt });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  clearUserAvatar(session.userId);
  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
