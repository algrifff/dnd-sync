// Security headers applied to every response by middleware.ts.
//
// The CSP here is deliberately pragmatic for v1: 'unsafe-inline' on
// script-src is allowed to keep Next.js's runtime chunks working without
// the nonce plumbing. Tightening to nonces ('strict-dynamic' + per-
// request nonce) is a Phase-8 polish item and does not block shipping.
//
// NB: `connect-src` explicitly allows ws: + wss: so the hocuspocus
// WebSocket connection in Phase 4 works. `frame-src 'self'` keeps PDF
// iframes working. `object-src 'none'` defence-in-depth against Flash/
// legacy embed attacks (irrelevant in 2026 but costs nothing).

/** Default security-header set. Safe to apply to every response,
 *  including static assets, since none of them interact with the values. */
export function securityHeaders(): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  return {
    'Content-Security-Policy': csp,
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  };
}

/** Attach the security headers to a Headers instance. Use from any
 *  Response building path that isn't a NextResponse. */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(securityHeaders())) {
    headers.set(name, value);
  }
}
