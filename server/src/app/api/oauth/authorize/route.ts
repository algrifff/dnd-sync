// POST /api/oauth/authorize — the consent decision. Session + CSRF, like
// every other mutation. Re-validates the whole authorization request
// (never trusts what the page rendered), checks the chosen world is one
// the user belongs to, mints a code and returns the redirect URL for the
// browser to follow.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { isGroupMember } from '@/lib/groups';
import { grantedScope, issueCode } from '@/lib/oauth';
import { checkAuthorizeRequest, redirectBack } from '@/lib/oauth-authorize';
import { publicUrls } from '@/lib/public-url';

export const dynamic = 'force-dynamic';

const Body = z.object({
  decision: z.enum(['approve', 'deny']),
  group_id: z.string().min(1).max(128).optional(),
  query: z.record(z.string()),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json({ error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' }, { status: 400 });
  }

  const urls = publicUrls(req.headers);
  const check = await checkAuthorizeRequest(body.query, urls.mcpResource);
  if (!check.ok) {
    if (!check.redirectable) return Response.json({ error: check.error, reason: check.description }, { status: 400 });
    const redirect = redirectBack(check.query.redirect_uri, urls.issuer, { error: check.error, description: check.description }, check.query.state);
    return Response.json({ redirect });
  }
  const { query } = check;

  if (body.decision === 'deny') {
    const redirect = redirectBack(query.redirect_uri, urls.issuer, { error: 'access_denied', description: 'the user declined' }, query.state);
    return Response.json({ redirect });
  }

  if (!body.group_id || !isGroupMember(session.userId, body.group_id)) {
    return Response.json({ error: 'forbidden', reason: 'pick a world you belong to' }, { status: 403 });
  }

  const code = issueCode({
    clientId: check.client.clientId,
    userId: session.userId,
    groupId: body.group_id,
    redirectUri: query.redirect_uri,
    codeChallenge: query.code_challenge,
    resource: urls.mcpResource,
    scope: grantedScope(query.scope),
  });
  return Response.json({ redirect: redirectBack(query.redirect_uri, urls.issuer, { code }, query.state) });
}
