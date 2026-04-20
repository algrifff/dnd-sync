// Double-submit CSRF token verification for non-Server-Action POST
// endpoints (uploads, explicit REST mutations). Server Actions already
// get CSRF protection from Next.js's Origin header check.
//
// The token is a 32-byte random hex string issued alongside the session
// and stored in `sessions.csrf_token`. The client reads it from the
// non-HttpOnly `compendium.csrf` cookie and echoes it in the
// `X-CSRF-Token` header on every state-changing request.

import type { Session } from './session';

type HeaderReader = { headers: { get(name: string): string | null } };

/** Compare the `X-CSRF-Token` header against the session's stored token.
 *  Returns null on match, or a 403 Response on mismatch / missing. */
export function verifyCsrf(req: HeaderReader, session: Session): Response | null {
  const presented = req.headers.get('x-csrf-token');
  if (!presented) {
    return csrfFail('missing csrf token');
  }
  if (!constantTimeEqual(presented, session.csrfToken)) {
    return csrfFail('csrf token mismatch');
  }
  return null;
}

function csrfFail(reason: string): Response {
  return new Response(JSON.stringify({ error: 'forbidden', reason }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Constant-time string comparison. Both operands are expected to be
 *  64-char hex strings (our token format). Length mismatches return
 *  false without early-exit. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
