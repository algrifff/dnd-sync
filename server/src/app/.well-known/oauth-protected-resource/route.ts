// GET /.well-known/oauth-protected-resource (RFC 9728). Public. Claude
// probes this root path when the 401 carries no resource_metadata hint.

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
