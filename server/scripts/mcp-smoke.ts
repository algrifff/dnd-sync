// Drives the MCP connector end to end against a running server, the
// way Claude does, over real HTTP: 401 challenge → discovery → client
// registration → consent → code exchange → MCP initialize / tools/list /
// tools/call → refresh rotation → revoke.
//
// The one thing it does not do over HTTP is log in: the web login is a
// Next server action, so the script mints a session straight into the
// server's SQLite file (same DATA_DIR) for the given user instead.
//
//   cd server && bun run scripts/mcp-smoke.ts [--base http://localhost:3000] [--user admin] [--keep]
//
// --keep skips the final revoke and prints the access token, so you can
// point the MCP Inspector at the same server afterwards.

import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../src/lib/db';
import { buildSessionCookies, createSession } from '../src/lib/session';
import { findUserByUsername } from '../src/lib/users';

type Flags = { base: string; user: string; keep: boolean };

function flags(argv: string[]): Flags {
  const out: Flags = { base: 'http://localhost:3000', user: 'admin', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i] ?? out.base;
    else if (a === '--user') out.user = argv[++i] ?? out.user;
    else if (a === '--keep') out.keep = true;
    else throw new Error(`unknown flag ${a}`);
  }
  out.base = out.base.replace(/\/+$/, '');
  return out;
}

function step(name: string, detail: string): void {
  console.log(`ok   ${name}: ${detail}`);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Read the body once, check the status, parse. */
async function expectJson<T>(res: Response, status: number, what: string): Promise<T> {
  const text = await res.text();
  assert(res.status === status, `${what}: HTTP ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

let rpcId = 1;
async function rpc<T>(mcpUrl: string, access: string, method: string, params: unknown = {}): Promise<T> {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const body = await expectJson<{ result?: T; error?: unknown }>(res, 200, method);
  assert(!body.error, `${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

type ToolCall = { content: { type: string; text: string }[]; isError?: boolean };

async function main(): Promise<void> {
  const { base, user, keep } = flags(process.argv.slice(2));
  const mcpUrl = `${base}/api/mcp`;

  const account = findUserByUsername(user);
  assert(account, `no user named ${user} in ${process.env.DATA_DIR ?? './.data'}`);
  const membership = getDb()
    .query<{ group_id: string; role: string }, [string]>('SELECT group_id, role FROM group_members WHERE user_id = ? LIMIT 1')
    .get(account.id);
  assert(membership, `${user} belongs to no world`);
  const session = createSession({ userId: account.id, groupId: membership.group_id, userAgent: 'mcp-smoke', ip: null });
  const cookie = buildSessionCookies(session).map((c) => `${c.name}=${c.value}`).join('; ');
  step('session', `${user} (${membership.role}) in world ${membership.group_id}`);

  const anon = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
  });
  const challenge = anon.headers.get('www-authenticate') ?? '';
  assert(anon.status === 401, `unauthenticated MCP call returned ${anon.status}, expected 401`);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  assert(metadataUrl, `401 without resource_metadata: ${challenge}`);
  step('401 challenge', challenge);

  const prm = await json<{ resource: string; authorization_servers: string[] }>(await fetch(metadataUrl));
  assert(prm.resource === mcpUrl, `protected resource metadata names ${prm.resource}, expected ${mcpUrl}`);
  const issuer = prm.authorization_servers[0];
  assert(issuer, 'no authorization server advertised');
  const asm = await json<{
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    revocation_endpoint: string;
    code_challenge_methods_supported: string[];
    client_id_metadata_document_supported: boolean;
  }>(await fetch(`${issuer}/.well-known/oauth-authorization-server`));
  assert(asm.code_challenge_methods_supported.includes('S256'), 'S256 not advertised');
  step('discovery', `issuer ${issuer}, CIMD ${asm.client_id_metadata_document_supported}, PKCE ${asm.code_challenge_methods_supported.join(',')}`);

  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await fetch(asm.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'mcp-smoke', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  });
  const { client_id: clientId } = await expectJson<{ client_id: string }>(reg, 201, 'registration');
  step('register', `client_id ${clientId}`);

  const verifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('hex');
  const query = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource: mcpUrl,
    scope: 'notes:read wrapup:submit',
  };
  const page = await fetch(`${asm.authorization_endpoint}?${new URLSearchParams(query)}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  assert(page.status === 200, `consent page returned ${page.status}`);
  const consent = await fetch(`${base}/api/oauth/authorize`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', group_id: membership.group_id, query }),
  });
  const redirect = new URL((await expectJson<{ redirect: string }>(consent, 200, 'consent')).redirect);
  const code = redirect.searchParams.get('code');
  assert(code, 'no code in redirect');
  assert(redirect.searchParams.get('state') === state, 'state mismatch');
  assert(redirect.searchParams.get('iss') === issuer, 'iss mismatch');
  step('consent', `redirect to ${redirect.origin}${redirect.pathname} with code, state and iss`);

  async function tokenRequest(form: Record<string, string>): Promise<Response> {
    return fetch(asm.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }
  const exchanged = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: mcpUrl,
  });
  let tokens = await expectJson<{ access_token: string; refresh_token: string; expires_in: number; scope: string }>(
    exchanged,
    200,
    'token exchange',
  );
  step('token', `access expires in ${tokens.expires_in}s, scope ${tokens.scope}`);

  const init = await rpc<{ protocolVersion: string; serverInfo: { name: string; version: string } }>(
    mcpUrl,
    tokens.access_token,
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '0' } },
  );
  step('initialize', `${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}`);

  const list = await rpc<{ tools: { name: string }[] }>(mcpUrl, tokens.access_token, 'tools/list');
  step('tools/list', list.tools.map((t) => t.name).join(', '));

  const campaigns = await rpc<ToolCall>(mcpUrl, tokens.access_token, 'tools/call', { name: 'list_campaigns', arguments: {} });
  step('tools/call list_campaigns', campaigns.content[0]?.text.split('\n')[0] ?? '');

  const browse = await rpc<ToolCall>(mcpUrl, tokens.access_token, 'tools/call', { name: 'browse_notes', arguments: { limit: 3 } });
  const firstPath = /^- (.+?) — /m.exec(browse.content[0]?.text ?? '')?.[1];
  step('tools/call browse_notes', firstPath ? `first path ${firstPath}` : (browse.content[0]?.text ?? ''));
  if (firstPath) {
    const read = await rpc<ToolCall>(mcpUrl, tokens.access_token, 'tools/call', { name: 'read_note', arguments: { path: firstPath } });
    assert(!read.isError, `read_note failed: ${read.content[0]?.text}`);
    step('tools/call read_note', `${read.content[0]?.text.length ?? 0} chars`);
  }

  const wrap = await rpc<ToolCall>(mcpUrl, tokens.access_token, 'tools/call', {
    name: 'submit_wrap_up',
    arguments: { session_path: 'Campaigns/smoke/Sessions/Nope.md', mentions: [] },
  });
  assert(wrap.isError === true && /not found/i.test(wrap.content[0]?.text ?? ''), `submit_wrap_up on a missing Session: ${wrap.content[0]?.text}`);
  step('tools/call submit_wrap_up', 'scope accepted; a missing Session reads as not found');

  const oldRefresh = tokens.refresh_token;
  const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId });
  tokens = await expectJson<typeof tokens>(refreshed, 200, 'refresh');
  const reused = await tokenRequest({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId });
  assert(reused.status === 400, `rotated refresh token still accepted (${reused.status})`);
  await rpc(mcpUrl, tokens.access_token, 'tools/list');
  step('refresh', 'rotated; old refresh token rejected; new access token works');

  if (keep) {
    console.log(`\nkept. access token for the inspector:\n${tokens.access_token}\n`);
    return;
  }
  const revoked = await fetch(asm.revocation_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.access_token }).toString(),
  });
  assert(revoked.status === 200, `revoke returned ${revoked.status}`);
  const after = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
  });
  assert(after.status === 401, `revoked token still accepted (${after.status})`);
  step('revoke', 'token rejected afterwards');

  const replay = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  assert(replay.status === 400, `code replay returned ${replay.status}, expected 400`);
  step('code reuse', 'rejected (revoking the grant on replay is covered by oauth.test.ts)');
  console.log('\nall good');
}

main().catch((err) => {
  console.error('FAIL', err instanceof Error ? err.message : err);
  process.exit(1);
});
