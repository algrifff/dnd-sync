// POST /api/mcp — the Streamable HTTP MCP endpoint Claude connects to.
// Bearer-token authenticated (never cookies, never CSRF: this is an API
// for a remote client, not the web app). A missing or invalid token
// gets the RFC 9728 401 that points Claude at the discovery metadata.
//
// Stateless: no session ids, no server-initiated SSE stream, so GET and
// DELETE are 405 as the MCP spec permits.

import type { NextRequest } from 'next/server';
import { authenticateAccessToken } from '@/lib/oauth';
import { corsHeaders, preflight, unauthorizedBearer } from '@/lib/oauth-http';
import { publicUrls } from '@/lib/public-url';
import { handleMcpRequest } from '@/lib/mcp/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return unauthorizedBearer(req.headers);

  const principal = authenticateAccessToken(match[1]!.trim(), publicUrls(req.headers).mcpResource);
  if (!principal) return unauthorizedBearer(req.headers, 'token is invalid, expired or revoked');

  try {
    const res = await handleMcpRequest(req, { groupId: principal.groupId, role: principal.role, scopes: principal.scopes });
    for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v);
    return res;
  } catch (err) {
    console.error('[mcp] request failed', err);
    return Response.json({ error: 'mcp_failed' }, { status: 500, headers: corsHeaders() });
  }
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS', ...corsHeaders() } });
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS', ...corsHeaders() } });
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
