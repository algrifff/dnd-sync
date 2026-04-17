// Multi-client convergence check.
//
// Spawns N y-websocket clients against the same doc, each inserts a unique
// line, and asserts that every client ends up seeing every line. Then all
// disconnect and a cold client reconnects to verify the persisted merge.
//
// Run against a server started with ADMIN_TOKEN/PLAYER_TOKEN in env.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import ws from 'ws';

(globalThis as unknown as { WebSocket: typeof ws }).WebSocket ??= ws as unknown as typeof ws;

const SERVER = process.env.SERVER ?? 'ws://localhost:3000/sync';
const TOKEN = process.env.PLAYER_TOKEN ?? process.env.ADMIN_TOKEN;
if (!TOKEN) {
  console.error('verify-multi: set PLAYER_TOKEN (or ADMIN_TOKEN) before running');
  process.exit(1);
}

const CLIENTS = Number(process.env.CLIENTS ?? 5);
const DOC_NAME = `verify-multi-${Date.now()}.md`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForSynced(provider: WebsocketProvider): Promise<void> {
  return new Promise((resolve) => {
    if (provider.synced) return resolve();
    const listener = (synced: boolean): void => {
      if (synced) {
        provider.off('sync', listener);
        resolve();
      }
    };
    provider.on('sync', listener);
  });
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

type Client = {
  id: number;
  doc: Y.Doc;
  provider: WebsocketProvider;
};

function mkClient(id: number): Client {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(SERVER, DOC_NAME, doc, {
    params: { token: TOKEN! },
  });
  return { id, doc, provider };
}

async function main(): Promise<void> {
  console.log(`verify-multi: ${CLIENTS} clients → ${SERVER}/${DOC_NAME}`);

  const clients: Client[] = Array.from({ length: CLIENTS }, (_, i) => mkClient(i));

  await step(`all ${CLIENTS} clients connect + sync`, async () => {
    await Promise.all(clients.map((c) => waitForSynced(c.provider)));
  });

  await step('each client inserts a unique line', async () => {
    for (const c of clients) {
      const line = `client-${c.id}-${Date.now()}\n`;
      c.doc.getText('content').insert(c.doc.getText('content').length, line);
      // Small gap so operations don't all hit the server in the exact same tick
      await sleep(30);
    }
  });

  await step('every client sees every line', async () => {
    // Give broadcasts time to settle.
    await sleep(400);
    const expected = clients.length;
    for (const c of clients) {
      const text = c.doc.getText('content').toString();
      const matches = text.match(/^client-\d+-/gm) ?? [];
      if (matches.length !== expected) {
        throw new Error(
          `client ${c.id} saw ${matches.length}/${expected} lines (content: ${JSON.stringify(text)})`,
        );
      }
    }
  });

  await step('all disconnect', async () => {
    for (const c of clients) c.provider.destroy();
    // Debounced persist + final flush + GC grace timer (15s) all kick in after disconnect.
    await sleep(1000);
  });

  const cold = mkClient(999);
  await step('cold-reconnect sees the merged state', async () => {
    await waitForSynced(cold.provider);
    await sleep(200);
    const text = cold.doc.getText('content').toString();
    const matches = text.match(/^client-\d+-/gm) ?? [];
    if (matches.length !== CLIENTS) {
      throw new Error(`cold client saw ${matches.length}/${CLIENTS} lines`);
    }
  });

  cold.provider.destroy();
  console.log('\nverify-multi: all checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nverify-multi FAILED:', err);
  process.exit(1);
});
