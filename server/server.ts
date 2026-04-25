// Custom entry that runs Next.js + the Hocuspocus WebSocket server on the same port.
// `bun run server.ts` in dev, production starts the same file with NODE_ENV=production.

import './env-bootstrap';

import { createServer } from 'node:http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { getDb } from '@/lib/db';
import { ensureConfig } from '@/lib/config';
import { getEnv } from '@/lib/env';
import { cleanupExpiredSessions } from '@/lib/session';
import { ensureDefaultAdmin, printAdminBanner, DEFAULT_GROUP_ID } from '@/lib/users';
import { ensureDefaultTemplates } from '@/lib/templates';
import { ensureDefaultFolders } from '@/lib/tree';
import { backfillIndexNotes } from '@/lib/index-notes';
import { backfillCampaignIndexes } from '@/lib/campaign-index';
import { handleCollabConnection, collabServer } from '@/collab/server';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

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
  ensureDefaultTemplates();
  ensureDefaultFolders(DEFAULT_GROUP_ID);
  backfillIndexNotes();
  // Seed / refresh the auto-managed callout in every campaign's
  // index.md so existing worlds catch up without waiting for the next
  // create / move / delete event.
  await backfillCampaignIndexes();
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

const collabWss = new WebSocketServer({ noServer: true });

collabWss.on('connection', (ws, req) => {
  handleCollabConnection(ws, req);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${hostname}`);

  if (url.pathname === '/collab' || url.pathname.startsWith('/collab/')) {
    collabWss.handleUpgrade(req, socket, head, (ws) => {
      collabWss.emit('connection', ws, req);
    });
    return;
  }

  // Destroy unknown upgrade requests (HMR is handled by Next itself).
  socket.destroy();
});

const bootStartedAt = Date.now();

server.listen(port, hostname, () => {
  console.log(
    `[compendium-server] listening on http://${hostname}:${port} (${dev ? 'dev' : 'prod'})`,
  );

  void captureServer({
    event: EVENTS.SERVER_BOOT,
    properties: {
      node_version: process.version,
      port,
      dev,
      git_sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? null,
      boot_duration_ms: Date.now() - bootStartedAt,
    },
  });
});

// Periodic uptime pulse — gaps in this event stream surface as
// downtime on the PostHog ops dashboard. Five minutes trades
// resolution for PostHog quota and keeps cost predictable.
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const heartbeat = setInterval(() => {
  void captureServer({
    event: EVENTS.SERVER_HEARTBEAT,
    properties: {
      uptime_seconds: Math.floor(process.uptime()),
      ws_document_count: collabServer.documents.size,
      memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  });
}, HEARTBEAT_INTERVAL_MS);

// Timer hook on Node keeps the event loop alive indefinitely; unref()
// so SIGTERM doesn't have to wait for the interval to fire.
heartbeat.unref?.();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    clearInterval(heartbeat);
  });
}
