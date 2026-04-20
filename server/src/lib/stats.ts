// Aggregates server stats for the dashboard. Pure read-only — every call
// is a quick SQLite query + a live-connections snapshot.

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb } from './db';
import { LATEST_SCHEMA_VERSION } from './migrations';
import { getLiveStats } from '@/ws/stats';

export type ServerStats = {
  uptimeSeconds: number;
  schemaVersion: number;
  commit: string | null;
  dbSizeBytes: number;
  textDocs: { count: number; totalBytes: number };
  binaryFiles: { count: number; totalBytes: number };
  connections: {
    total: number;
    byDoc: Array<{ path: string; connections: number }>;
  };
  recentDocs: Array<{ path: string; updatedAt: number; bytes: number }>;
};

function dbSize(): number {
  try {
    const dir = resolve(process.env.DATA_DIR ?? './.data');
    return statSync(join(dir, 'compendium.db')).size;
  } catch {
    return 0;
  }
}

export function collectStats(): ServerStats {
  const db = getDb();

  const text = db
    .query<{ count: number; bytes: number }, []>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(length(yjs_state)), 0) AS bytes FROM text_docs',
    )
    .get() ?? { count: 0, bytes: 0 };

  const bin = db
    .query<{ count: number; bytes: number }, []>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM binary_files',
    )
    .get() ?? { count: 0, bytes: 0 };

  const recent = db
    .query<{ path: string; updated_at: number; bytes: number }, []>(
      `SELECT path, updated_at, length(yjs_state) AS bytes
         FROM text_docs
         ORDER BY updated_at DESC
         LIMIT 10`,
    )
    .all();

  const live = getLiveStats();

  return {
    uptimeSeconds: Math.round(process.uptime()),
    schemaVersion: LATEST_SCHEMA_VERSION,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    dbSizeBytes: dbSize(),
    textDocs: { count: text.count, totalBytes: text.bytes },
    binaryFiles: { count: bin.count, totalBytes: bin.bytes },
    connections: { total: live.totalConnections, byDoc: live.byDoc },
    recentDocs: recent.map((r) => ({
      path: r.path,
      updatedAt: r.updated_at,
      bytes: r.bytes,
    })),
  };
}
