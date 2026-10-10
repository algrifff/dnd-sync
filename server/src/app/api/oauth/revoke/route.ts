// POST /api/oauth/revoke — RFC 7009. Public client, so no client auth;
// presenting the token is the proof. Always 200, even for unknown tokens.

import type { NextRequest } from 'next/server';
import { revokeToken } from '@/lib/oauth';
import { jsonNoStore, oauthError, preflight, readFormOrJson } from '@/lib/oauth-http';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  let form: Record<string, string>;
  try {
    form = await readFormOrJson(req);
  } catch {
    return oauthError('invalid_request', 'unreadable body');
  }
  if (!form.token) return oauthError('invalid_request', 'token is required');
  revokeToken(form.token);
  return jsonNoStore({ ok: true });
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
