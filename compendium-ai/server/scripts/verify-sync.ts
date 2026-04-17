// Integration check for Milestone 2.3.
// Usage: bun run scripts/verify-sync.ts  (against a running server)
//
//   1. Client A connects, writes "hello"
//   2. Client B connects to same doc, should receive "hello"
//   3. Both disconnect
//   4. Client C reconnects cold — should still receive "hello" from SQLite
//
// Exits non-zero on any failure.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import ws from 'ws';

// Bun ships a global WebSocket; WebsocketProvider prefers it. For Node-style
// usage y-websocket lets us inject the ws module.
(globalThis as unknown as { WebSocket: typeof ws }).WebSocket ??= ws as unknown as typeof ws;

const SERVER = process.env.SERVER ?? 'ws://localhost:3000/sync';
const DOC_NAME = `verify-${Date.now()}.md`;

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
  console.log(`verify-sync: ${SERVER}/${DOC_NAME}`);

  const docA = new Y.Doc();
  const providerA = new WebsocketProvider(SERVER, DOC_NAME, docA);

  await step('client A connects + syncs', async () => {
    await waitForSynced(providerA);
  });

  await step('client A writes "hello"', async () => {
    docA.getText('content').insert(0, 'hello');
  });

  const docB = new Y.Doc();
  const providerB = new WebsocketProvider(SERVER, DOC_NAME, docB);

  await step('client B connects + receives "hello"', async () => {
    await waitForSynced(providerB);
    await sleep(100);
    const seen = docB.getText('content').toString();
    if (seen !== 'hello') throw new Error(`expected "hello", got "${seen}"`);
  });

  await step('both disconnect', async () => {
    providerA.destroy();
    providerB.destroy();
    // Allow the server's debounced persist (300ms) + final writeStateNow.
    await sleep(800);
  });

  const docC = new Y.Doc();
  const providerC = new WebsocketProvider(SERVER, DOC_NAME, docC);

  await step('client C connects cold + receives persisted "hello"', async () => {
    await waitForSynced(providerC);
    await sleep(100);
    const seen = docC.getText('content').toString();
    if (seen !== 'hello') throw new Error(`expected persisted "hello", got "${seen}"`);
  });

  providerC.destroy();
  console.log('\nverify-sync: all checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nverify-sync FAILED:', err);
  process.exit(1);
});
