// Aggregates server stats for the admin dashboard. Pure read-only.

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb } from './db';
import { LATEST_SCHEMA_VERSION } from './migrations';

export type ServerStats = {
  uptimeSeconds: number;
  schemaVersion: number;
  commit: string | null;
  dbSizeBytes: number;
  notes: { count: number };
  assets: { count: number; totalBytes: number };
  recentDocs: Array<{ path: string; updatedAt: number }>;
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

  const notes = db
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notes')
    .get() ?? { count: 0 };

  const assets = db
    .query<{ count: number; bytes: number }, []>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM assets',
    )
    .get() ?? { count: 0, bytes: 0 };

  const recent = db
    .query<{ path: string; updated_at: number }, []>(
      `SELECT path, updated_at FROM notes ORDER BY updated_at DESC LIMIT 10`,
    )
    .all();

  return {
    uptimeSeconds: Math.round(process.uptime()),
    schemaVersion: LATEST_SCHEMA_VERSION,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    dbSizeBytes: dbSize(),
    notes: { count: notes.count },
    assets: { count: assets.count, totalBytes: assets.bytes },
    recentDocs: recent.map((r) => ({ path: r.path, updatedAt: r.updated_at })),
  };
}
