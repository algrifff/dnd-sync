// POST /api/oauth/register — RFC 7591 dynamic client registration.
// Public (no session, no CSRF): any MCP client may register itself as a
// public client. Only redirect URIs are trusted from the body, and only
// after they pass the OAuth 2.1 HTTPS-or-loopback rule.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { isAcceptableRedirectUri, registerClient } from '@/lib/oauth';
import { clientIp, jsonNoStore, oauthError, preflight } from '@/lib/oauth-http';
import { oauthRegisterLimiter } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const Body = z.object({
  client_name: z.string().trim().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(20),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
  response_types: z.array(z.literal('code')).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const ip = clientIp(req.headers);
  const decision = oauthRegisterLimiter.check(ip, false);
  if (!decision.allowed) {
    return oauthError('invalid_client_metadata', 'too many registrations, try again later', 429);
  }
  oauthRegisterLimiter.recordFailure(ip, false);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return oauthError('invalid_client_metadata', err instanceof Error ? err.message : 'bad body');
  }
  const rejected = body.redirect_uris.find((u) => !isAcceptableRedirectUri(u));
  if (rejected) return oauthError('invalid_redirect_uri', `redirect_uri must be https or loopback: ${rejected}`);

  const client = registerClient({ clientName: body.client_name ?? 'MCP client', redirectUris: body.redirect_uris });
  return jsonNoStore(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
