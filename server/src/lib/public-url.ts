// The one place that knows the app's public origin. OAuth metadata,
// the MCP resource identifier and the consent-page redirects all derive
// from it, so they always agree with each other.
//
// PUBLIC_APP_URL wins when set (Railway). Otherwise the forwarded host
// headers of the current request are used, which is what a self-hosted
// deploy behind a reverse proxy sends.

export type PublicUrls = {
  /** Origin without trailing slash, e.g. https://compendium.example. */
  origin: string;
  /** RFC 8414 issuer. Same as origin: the app is its own auth server. */
  issuer: string;
  /** RFC 8707 canonical resource identifier of the MCP endpoint. */
  mcpResource: string;
  protectedResourceMetadata: string;
  authorizationServerMetadata: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
};

export const MCP_PATH = '/api/mcp';

type HeaderReader = { get(name: string): string | null };

let warnedNoPublicUrl = false;

export function publicOrigin(headers: HeaderReader): string {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production' && !warnedNoPublicUrl) {
    warnedNoPublicUrl = true;
    console.warn(
      '[oauth] PUBLIC_APP_URL is not set; OAuth metadata is derived from request headers. Set it so a forged Host header cannot change the issuer or MCP resource.',
    );
  }
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost:3000';
  const proto = headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`.toLowerCase();
}

export function publicUrls(headers: HeaderReader): PublicUrls {
  const origin = publicOrigin(headers);
  return {
    origin,
    issuer: origin,
    mcpResource: origin + MCP_PATH,
    protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`,
    authorizationServerMetadata: `${origin}/.well-known/oauth-authorization-server`,
    authorizationEndpoint: `${origin}/oauth/authorize`,
    tokenEndpoint: `${origin}/api/oauth/token`,
    registrationEndpoint: `${origin}/api/oauth/register`,
    revocationEndpoint: `${origin}/api/oauth/revoke`,
  };
}
