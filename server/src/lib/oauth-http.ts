// Response helpers shared by the OAuth and MCP route handlers.
//
// These endpoints are called by Claude's servers and by MCP clients
// running in browsers (the MCP Inspector, for one), never with cookies,
// so a wildcard CORS policy exposes nothing: every call is either
// public metadata or authenticated by a bearer token the caller holds.

import { SCOPE } from './oauth';
import { publicUrls } from './public-url';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'Access-Control-Expose-Headers': 'www-authenticate, mcp-protocol-version, mcp-session-id',
  'Access-Control-Max-Age': '86400',
};

export function corsHeaders(): Record<string, string> {
  return { ...CORS };
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** JSON that must never be cached (RFC 6749 §5.1). */
export function jsonNoStore(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache', ...CORS, ...extra },
  });
}

/** RFC 6749 §5.2 error body. */
export function oauthError(error: string, description: string, status = 400): Response {
  return jsonNoStore({ error, error_description: description }, status);
}

/** The 401 that starts Claude's sign-in flow (RFC 9728 §5.1). The
 *  scope parameter is what Claude requests at the authorization
 *  endpoint (MCP authorization spec, "Scope Selection Strategy"). */
export function unauthorizedBearer(headers: Headers, description?: string): Response {
  const urls = publicUrls(headers);
  const params = [`resource_metadata="${urls.protectedResourceMetadata}"`, `scope="${SCOPE}"`];
  if (description) params.push('error="invalid_token"', `error_description="${description}"`);
  return jsonNoStore({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer ${params.join(', ')}` });
}

export function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || 'unknown';
  return headers.get('x-real-ip') ?? 'unknown';
}

/** Token and registration bodies arrive as application/x-www-form-urlencoded
 *  (RFC 6749 §4.1.3) or, from some clients, as JSON. Accept both. */
export async function readFormOrJson(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  const out: Record<string, string> = {};
  if (type.includes('application/json')) {
    const body = (await req.json()) as unknown;
    if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  const params = new URLSearchParams(await req.text());
  for (const [k, v] of params) out[k] = v;
  return out;
}
