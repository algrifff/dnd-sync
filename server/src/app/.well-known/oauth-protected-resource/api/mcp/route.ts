// GET /.well-known/oauth-protected-resource/api/mcp — the path-suffixed
// form of RFC 9728 §3.1 for the MCP endpoint at /api/mcp. Same document
// as the root form.

import type { NextRequest } from 'next/server';
import { protectedResourceMetadata } from '@/lib/oauth-metadata';
import { corsHeaders, preflight } from '@/lib/oauth-http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return Response.json(protectedResourceMetadata(req.headers), { headers: corsHeaders() });
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
