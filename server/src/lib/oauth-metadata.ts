// RFC 9728 protected resource metadata and RFC 8414 authorization
// server metadata, both derived from the public origin so the
// `resource`, `issuer` and endpoint URLs can never disagree.

import { SCOPE } from './oauth';
import { publicUrls } from './public-url';

type HeaderReader = { get(name: string): string | null };

export function protectedResourceMetadata(headers: HeaderReader): Record<string, unknown> {
  const urls = publicUrls(headers);
  return {
    resource: urls.mcpResource,
    authorization_servers: [urls.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Compendium',
  };
}

export function authorizationServerMetadata(headers: HeaderReader): Record<string, unknown> {
  const urls = publicUrls(headers);
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorizationEndpoint,
    token_endpoint: urls.tokenEndpoint,
    registration_endpoint: urls.registrationEndpoint,
    revocation_endpoint: urls.revocationEndpoint,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
