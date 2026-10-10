// GET /.well-known/oauth-authorization-server (RFC 8414). Public.

import type { NextRequest } from 'next/server';
import { authorizationServerMetadata } from '@/lib/oauth-metadata';
import { corsHeaders, preflight } from '@/lib/oauth-http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return Response.json(authorizationServerMetadata(req.headers), { headers: corsHeaders() });
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
