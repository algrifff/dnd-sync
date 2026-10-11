// Validation of an authorization request, shared by the consent page
// (which renders it) and POST /api/oauth/authorize (which acts on it).
// Both must agree on what a well-formed request is, and both must
// refuse to redirect anywhere the client did not register.

import { z } from 'zod';
import { redirectUriAllowed, resolveClient, type OAuthClient } from './oauth';

export const AuthorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().min(1).max(2048),
  state: z.string().max(2048).optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  resource: z.string().max(2048).optional(),
  scope: z.string().max(512).optional(),
});

export type AuthorizeQuery = z.infer<typeof AuthorizeQuery>;

/** Redirect URIs of Anthropic's hosted Claude apps, from
 *  https://claude.com/docs/connectors/building/authentication
 *  ("Callback URLs"). Any client can register under any name, so the
 *  consent page trusts the redirect URI, never the name. */
const CLAUDE_REDIRECT_URIS: readonly string[] = ['https://claude.ai/api/mcp/auth_callback'];

export function isKnownClaudeRedirect(redirectUri: string): boolean {
  return CLAUDE_REDIRECT_URIS.includes(redirectUri);
}

export type AuthorizeCheck =
  /** Safe to render the consent screen and, later, redirect back. */
  | { ok: true; client: OAuthClient; query: AuthorizeQuery }
  /** The request is malformed in a way we can report to the client. */
  | { ok: false; redirectable: true; query: AuthorizeQuery; error: string; description: string }
  /** The client or redirect URI is untrusted: show an error, never redirect. */
  | { ok: false; redirectable: false; error: string; description: string };

export async function checkAuthorizeRequest(
  raw: Record<string, string | undefined>,
  mcpResource: string,
): Promise<AuthorizeCheck> {
  const parsed = AuthorizeQuery.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, redirectable: false, error: 'invalid_request', description: parsed.error.issues[0]?.message ?? 'bad request' };
  }
  const query = parsed.data;
  const client = await resolveClient(query.client_id);
  if (!client) {
    return { ok: false, redirectable: false, error: 'invalid_client', description: 'unknown client_id' };
  }
  if (!redirectUriAllowed(client, query.redirect_uri)) {
    return { ok: false, redirectable: false, error: 'invalid_request', description: 'redirect_uri is not registered for this client' };
  }
  if (query.resource !== undefined && query.resource !== mcpResource) {
    return { ok: false, redirectable: true, query, error: 'invalid_target', description: `resource must be ${mcpResource}` };
  }
  return { ok: true, client, query };
}

/** Build the redirect back to the client (RFC 6749 §4.1.2, RFC 9207 iss). */
export function redirectBack(
  redirectUri: string,
  issuer: string,
  params: { code: string } | { error: string; description: string },
  state: string | undefined,
): string {
  const url = new URL(redirectUri);
  if ('code' in params) url.searchParams.set('code', params.code);
  else {
    url.searchParams.set('error', params.error);
    url.searchParams.set('error_description', params.description);
  }
  if (state !== undefined) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}
