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
import { pruneExpiredAuditLog } from '@/lib/audit';
import { recoverImportJobs, startImportJanitor } from '@/lib/import-orchestrate';
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
  // Seed / refresh the auto-managed callout in every campaign + every
  // subfolder under every campaign so existing worlds catch up
  // without waiting for the next create / move / delete event.
  await backfillCampaignIndexes();
  const removed = cleanupExpiredSessions();
  if (removed > 0) console.log(`[compendium-server] pruned ${removed} expired session(s)`);
  const removedAudit = pruneExpiredAuditLog();
  if (removedAudit > 0) console.log(`[compendium-server] pruned ${removedAudit} expired audit row(s)`);
  // Import jobs track their phase in-process, so anything left mid-flight
  // by a crash or redeploy is unreachable — the DM's pending-answer
  // resolver in particular is just a Promise callback that died with the
  // old process. Resolve them before we start accepting traffic, so the
  // UI never shows a job that can no longer advance. Interrupted jobs are
  // failed (not resumed) — resuming would fire billed AI calls with no
  // human present on a job whose owner may have closed the tab hours ago.
  const recovered = recoverImportJobs();
  if (recovered.interrupted.length > 0 || recovered.expired.length > 0 || recovered.orphanZips > 0) {
    console.log(
      `[compendium-server] import recovery: ${recovered.interrupted.length} interrupted, ` +
        `${recovered.expired.length} expired, ${recovered.orphanZips} orphan zip(s) removed`,
    );
  }
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

// Recurring cleanup of unbounded-growth tables. Both cleanupExpiredSessions
// and pruneExpiredAuditLog were previously only run once at boot, so a
// long-lived process (this is a persistent server, not serverless) would
// accumulate expired sessions and out-of-retention audit rows for its
// entire uptime. Both are single indexed DELETEs — cheap enough to run
// hourly without a dedicated scheduler, frequent enough that a
// weeks-long deployment never lets either table grow far past what a
// restart would have cleaned anyway.
const CLEANUP_INTERVAL_MS = 60 * 60_000;
const cleanupTimer = setInterval(() => {
  try {
    const removedSessions = cleanupExpiredSessions();
    if (removedSessions > 0) {
      console.log(`[compendium-server] pruned ${removedSessions} expired session(s)`);
    }
    const removedAudit = pruneExpiredAuditLog();
    if (removedAudit > 0) {
      console.log(`[compendium-server] pruned ${removedAudit} expired audit row(s)`);
    }
  } catch (err) {
    console.error('[compendium-server] periodic cleanup failed:', err);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

// Durable backstop for the two import failure modes an in-process timer
// can't cover: a job left waiting on a DM answer that never comes, and a
// raw upload ZIP whose job row died before it could be reclaimed. The
// boot-time recovery above only runs once; this catches jobs that stall
// while the process stays up. Timer is unref'd internally.
const stopImportJanitor = startImportJanitor();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    clearInterval(heartbeat);
    clearInterval(cleanupTimer);
    stopImportJanitor();
  });
}
