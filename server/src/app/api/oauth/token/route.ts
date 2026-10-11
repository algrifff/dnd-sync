// POST /api/oauth/token — RFC 6749 §4.1.3 code exchange and §6 refresh,
// both for public clients (no client secret, PKCE required). Public
// endpoint, rate-limited per IP on failures.

import type { NextRequest } from 'next/server';
import { redeemCode, refreshTokens, type TokenResult } from '@/lib/oauth';
import { clientIp, jsonNoStore, oauthError, preflight, readFormOrJson } from '@/lib/oauth-http';
import { oauthTokenLimiter } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const ip = clientIp(req.headers);
  const decision = oauthTokenLimiter.check(ip, false);
  if (!decision.allowed) return oauthError('invalid_request', 'too many failed attempts, try again later', 429);

  let form: Record<string, string>;
  try {
    form = await readFormOrJson(req);
  } catch {
    return oauthError('invalid_request', 'unreadable body');
  }

  const clientId = form.client_id;
  if (!clientId) return oauthError('invalid_client', 'client_id is required', 401);

  let result: TokenResult;
  switch (form.grant_type) {
    case 'authorization_code': {
      const { code, redirect_uri, code_verifier, resource } = form;
      if (!code || !redirect_uri || !code_verifier) {
        return oauthError('invalid_request', 'code, redirect_uri and code_verifier are required');
      }
      result = redeemCode({ code, clientId, redirectUri: redirect_uri, codeVerifier: code_verifier, resource: resource ?? null });
      break;
    }
    case 'refresh_token': {
      if (!form.refresh_token) return oauthError('invalid_request', 'refresh_token is required');
      result = refreshTokens({ refreshToken: form.refresh_token, clientId });
      break;
    }
    default:
      return oauthError('unsupported_grant_type', 'use authorization_code or refresh_token');
  }

  if (!result.ok) {
    oauthTokenLimiter.recordFailure(ip, false);
    return oauthError(result.error, result.description, result.error === 'invalid_client' ? 401 : 400);
  }
  oauthTokenLimiter.recordSuccess(ip);
  return jsonNoStore(result.tokens);
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
