// Custom entry that runs Next.js + a WebSocket upgrade path on the same port.
// `bun run server.ts` in dev, production starts the same file with NODE_ENV=production.
// The WS handler is a stub for Milestone 2.1; Yjs wiring lands in Milestone 2.3.

import { createServer } from 'node:http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { WS_PATH } from '@compendium/shared';

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const dev = process.env.NODE_ENV !== 'production';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[compendium-server] request failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('internal error');
    }
  });
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  // Milestone 2.3 plugs Yjs in here. For now, confirm the handshake works.
  ws.on('close', () => {});
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', `http://${hostname}`).pathname;
  if (pathname === WS_PATH || pathname.startsWith(`${WS_PATH}/`)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    // Let Next handle its own upgrades (e.g. HMR in dev).
    socket.destroy();
  }
});

server.listen(port, hostname, () => {
  console.log(
    `[compendium-server] listening on http://${hostname}:${port} (${dev ? 'dev' : 'prod'})`,
  );
});
