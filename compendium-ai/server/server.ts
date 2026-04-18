// Custom entry that runs Next.js + a WebSocket upgrade path on the same port.
// `bun run server.ts` in dev, production starts the same file with NODE_ENV=production.
// The WS handler is a stub for Milestone 2.1; Yjs wiring lands in Milestone 2.3.

import { createServer } from 'node:http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { WS_PATH } from '@compendium/shared';
import { getDb } from '@/lib/db';
import { parseBearer, verifyToken } from '@/lib/auth';
import { ensureConfig } from '@/lib/config';
import { getEnv } from '@/lib/env';
import { checkAuthAttempt, recordAuthFailure, recordAuthSuccess } from '@/lib/ratelimit';
import { cleanupExpiredSessions } from '@/lib/session';
import { ensureDefaultAdmin, printAdminBanner } from '@/lib/users';
import { handleConnection } from '@/ws/setup';
import { handleCollabConnection } from '@/collab/server';

// Validate environment before touching anything else — fail fast on
// misconfiguration rather than at the first request.
const env = getEnv();

const port = env.port;
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const dev = env.nodeEnv !== 'production';

// Open SQLite (runs migrations) then seed config + admin user + prune
// expired sessions. ensureConfig logs the plugin admin token if freshly
// created; ensureDefaultAdmin logs the web-app admin password if it
// generated one (new DB only).
getDb();
ensureConfig();
{
  const seed = await ensureDefaultAdmin();
  printAdminBanner(seed);
  const removed = cleanupExpiredSessions();
  if (removed > 0) console.log(`[compendium-server] pruned ${removed} expired session(s)`);
}

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
const collabWss = new WebSocketServer({ noServer: true });

// Symbol-keyed stash so the upgrade handler can pass the verified token
// into the 'connection' event handler without exposing it as a public
// field on the request. The token is never logged.
const kToken = Symbol('compendium.wsToken');
type TokenCarrier = { [kToken]?: string | null };

wss.on('connection', (ws, req) => {
  const token = (req as TokenCarrier)[kToken] ?? null;
  handleConnection(ws, req, token);
});

collabWss.on('connection', (ws, req) => {
  handleCollabConnection(ws, req);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${hostname}`);

  // Route 1: new hocuspocus /collab path. Auth happens inside hocuspocus's
  // onAuthenticate hook (reads the session cookie from the request).
  if (url.pathname === '/collab' || url.pathname.startsWith('/collab/')) {
    collabWss.handleUpgrade(req, socket, head, (ws) => {
      collabWss.emit('connection', ws, req);
    });
    return;
  }

  // Route 2: legacy plugin-era /sync path. Kept until Phase 8.
  if (!url.pathname.startsWith(`${WS_PATH}/`)) {
    // Let Next handle its own upgrades (e.g. HMR in dev).
    socket.destroy();
    return;
  }

  const remote = req.socket.remoteAddress ?? 'unknown';
  const isLocalhost =
    !dev
      ? false
      : remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

  const decision = checkAuthAttempt(remote, isLocalhost);
  if (!decision.allowed) {
    const retrySec = Math.ceil(decision.retryAfterMs / 1000);
    socket.write(
      `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retrySec}\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
    return;
  }

  const token =
    parseBearer(req.headers['authorization'] as string | undefined) ??
    url.searchParams.get('token');
  if (!verifyToken(token)) {
    if (recordAuthFailure(remote, isLocalhost)) {
      console.warn(`[auth] rate-limited ${remote}`);
    }
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  recordAuthSuccess(remote);
  (req as TokenCarrier)[kToken] = token;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(port, hostname, () => {
  console.log(
    `[compendium-server] listening on http://${hostname}:${port} (${dev ? 'dev' : 'prod'})`,
  );
});
