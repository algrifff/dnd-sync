// Integration check for Milestone 3.
// - 401 without token
// - /api/health is open (no token)
// - 200 with player token
// - binary PUT + GET roundtrip
// - /api/search finds a doc seeded through WebSocket
//
// Requires ADMIN_TOKEN + PLAYER_TOKEN set in the environment that launched
// the server, and also exposed here so the script can authenticate.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import ws from 'ws';

(globalThis as unknown as { WebSocket: typeof ws }).WebSocket ??= ws as unknown as typeof ws;

const SERVER_HTTP = process.env.SERVER_HTTP ?? 'http://localhost:3000';
const SERVER_WS = process.env.SERVER_WS ?? 'ws://localhost:3000/sync';
const PLAYER_TOKEN = process.env.PLAYER_TOKEN;
if (!PLAYER_TOKEN) {
  console.error('verify-api: set PLAYER_TOKEN before running');
  process.exit(1);
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  · ${label}...`);
  try {
    await fn();
    console.log(' ok');
  } catch (err) {
    console.log(' FAIL');
    throw err;
  }
}

async function main(): Promise<void> {
  console.log(`verify-api: ${SERVER_HTTP}`);

  await step('GET /api/health is open (no token)', async () => {
    const res = await fetch(`${SERVER_HTTP}/api/health`);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const body = (await res.json()) as { ok?: boolean };
    if (!body.ok) throw new Error(`body.ok not true: ${JSON.stringify(body)}`);
  });

  await step('GET /api/search without token returns 401', async () => {
    const res = await fetch(`${SERVER_HTTP}/api/search?q=anything`);
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });

  await step('GET /api/search with player token returns 200', async () => {
    const res = await fetch(`${SERVER_HTTP}/api/search?q=anything`, { headers: bearer(PLAYER_TOKEN) });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  });

  const imgPath = `Assets/Portraits/verify-${Date.now()}.bin`;
  const imgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

  await step('PUT /api/files/* writes binary', async () => {
    const res = await fetch(`${SERVER_HTTP}/api/files/${imgPath}`, {
      method: 'PUT',
      headers: { ...bearer(PLAYER_TOKEN), 'Content-Type': 'application/octet-stream' },
      body: imgBytes,
    });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; size?: number };
    if (!body.ok || body.size !== imgBytes.byteLength) {
      throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    }
  });

  await step('GET /api/files/* reads bytes back', async () => {
    const res = await fetch(`${SERVER_HTTP}/api/files/${imgPath}`, { headers: bearer(PLAYER_TOKEN) });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const back = new Uint8Array(await res.arrayBuffer());
    if (back.byteLength !== imgBytes.byteLength) {
      throw new Error(`length mismatch: got ${back.byteLength}`);
    }
    for (let i = 0; i < back.length; i++) {
      if (back[i] !== imgBytes[i]) throw new Error(`byte ${i} differs`);
    }
  });

  await step('DELETE /api/files/* removes', async () => {
    const res = await fetch(`${SERVER_HTTP}/api/files/${imgPath}`, {
      method: 'DELETE',
      headers: bearer(PLAYER_TOKEN),
    });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; deleted?: number };
    if (body.deleted !== 1) throw new Error(`expected deleted=1, got ${body.deleted}`);
  });

  await step('GET /api/files/* after delete returns 404', async () => {
    const res = await fetch(`${SERVER_HTTP}/api/files/${imgPath}`, { headers: bearer(PLAYER_TOKEN) });
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
  });

  const docName = `verify-search-${Date.now()}.md`;
  const docA = new Y.Doc();
  const providerA = new WebsocketProvider(SERVER_WS, docName, docA, {
    params: { token: PLAYER_TOKEN },
  });
  await new Promise<void>((resolve) => providerA.once('sync', (s: boolean) => s && resolve()));
  docA.getText('content').insert(0, 'The dragon breathes fire in the caverns.');
  await sleep(600); // wait for debounced persist (300ms) + slack

  await step('/api/search finds the seeded doc by prefix', async () => {
    const res = await fetch(`${SERVER_HTTP}/api/search?q=drag`, { headers: bearer(PLAYER_TOKEN) });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const body = (await res.json()) as {
      query: string;
      results: Array<{ path: string; snippet: string }>;
    };
    const hit = body.results.find((r) => r.path === docName);
    if (!hit) {
      throw new Error(
        `doc not in results (results: ${body.results.map((r) => r.path).join(', ')})`,
      );
    }
    if (!/dragon/i.test(hit.snippet)) {
      throw new Error(`snippet missing 'dragon': ${hit.snippet}`);
    }
  });

  providerA.destroy();

  console.log('\nverify-api: all checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nverify-api FAILED:', err);
  process.exit(1);
});
