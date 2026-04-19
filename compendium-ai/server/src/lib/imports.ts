// Import-job helpers.
//
// An import job tracks one AI-assisted ingest end-to-end: the
// uploaded ZIP on disk, the classical parse result, the AI-produced
// plan, the review state, and — once the apply runs — a summary of
// what actually landed. State lives in the import_jobs row; the
// ZIP lives under DATA_DIR/imports/.
//
// Phase 1a is scaffold only: upload lands here with status 'uploaded'
// and nothing else runs. Phases 1b → 1f hook classical parse, AI
// analyse, and apply into this state machine.

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb } from './db';

export const IMPORT_STATUSES = [
  'uploaded',
  'parsing',
  'analysing',
  'ready',
  'applied',
  'cancelled',
  'failed',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export type ImportJob = {
  id: string;
  groupId: string;
  createdBy: string;
  status: ImportStatus;
  rawZipPath: string | null;
  plan: unknown;
  stats: unknown;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string;
  group_id: string;
  created_by: string;
  status: string;
  raw_zip_path: string | null;
  plan_json: string | null;
  stats_json: string | null;
  created_at: number;
  updated_at: number;
};

function rowToJob(r: Row): ImportJob {
  const parseJson = (v: string | null): unknown => {
    if (!v) return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  return {
    id: r.id,
    groupId: r.group_id,
    createdBy: r.created_by,
    status: r.status as ImportStatus,
    rawZipPath: r.raw_zip_path,
    plan: parseJson(r.plan_json),
    stats: parseJson(r.stats_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Temp file handling ─────────────────────────────────────────────────

/** Directory under the mounted DATA_DIR for in-flight imports. Kept
 *  separate from tmp/ so restart doesn't nuke an import mid-review. */
export function importsDir(): string {
  const base = resolve(process.env.DATA_DIR ?? './.data', 'imports');
  mkdirSync(base, { recursive: true });
  return base;
}

/** Persist an uploaded ZIP onto disk, return its absolute path. */
export function writeJobZip(jobId: string, bytes: Uint8Array): string {
  const path = join(importsDir(), `${jobId}.zip`);
  writeFileSync(path, bytes);
  return path;
}

/** Best-effort deletion of a job's ZIP. Called on apply / cancel /
 *  failure so we don't accumulate half-ingested blobs on disk. */
export function deleteJobZip(job: ImportJob | null): void {
  if (!job?.rawZipPath) return;
  try {
    rmSync(job.rawZipPath, { force: true });
  } catch {
    /* best-effort */
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────

export function createImportJob(opts: {
  groupId: string;
  createdBy: string;
  rawZipPath: string;
}): ImportJob {
  const now = Date.now();
  const id = randomUUID();
  getDb()
    .query(
      `INSERT INTO import_jobs
         (id, group_id, created_by, status, raw_zip_path,
          plan_json, stats_json, created_at, updated_at)
       VALUES (?, ?, ?, 'uploaded', ?, NULL, NULL, ?, ?)`,
    )
    .run(id, opts.groupId, opts.createdBy, opts.rawZipPath, now, now);
  return {
    id,
    groupId: opts.groupId,
    createdBy: opts.createdBy,
    status: 'uploaded',
    rawZipPath: opts.rawZipPath,
    plan: null,
    stats: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function getImportJob(id: string): ImportJob | null {
  const row = getDb()
    .query<Row, [string]>(
      `SELECT id, group_id, created_by, status, raw_zip_path,
              plan_json, stats_json, created_at, updated_at
         FROM import_jobs WHERE id = ?`,
    )
    .get(id);
  return row ? rowToJob(row) : null;
}

/** Jobs the session can see on the home-page resumable banner: their
 *  own, still-open (analysing / ready). */
export function listOpenJobsForUser(
  groupId: string,
  userId: string,
): ImportJob[] {
  return getDb()
    .query<Row, [string, string]>(
      `SELECT id, group_id, created_by, status, raw_zip_path,
              plan_json, stats_json, created_at, updated_at
         FROM import_jobs
        WHERE group_id = ? AND created_by = ?
          AND status IN ('uploaded', 'parsing', 'analysing', 'ready')
        ORDER BY updated_at DESC`,
    )
    .all(groupId, userId)
    .map(rowToJob);
}

export function updateImportJob(
  id: string,
  patch: {
    status?: ImportStatus;
    rawZipPath?: string | null;
    plan?: unknown;
    stats?: unknown;
  },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.rawZipPath !== undefined) {
    sets.push('raw_zip_path = ?');
    values.push(patch.rawZipPath);
  }
  if (patch.plan !== undefined) {
    sets.push('plan_json = ?');
    values.push(patch.plan === null ? null : JSON.stringify(patch.plan));
  }
  if (patch.stats !== undefined) {
    sets.push('stats_json = ?');
    values.push(patch.stats === null ? null : JSON.stringify(patch.stats));
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);
  getDb()
    .query(`UPDATE import_jobs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function cancelImportJob(id: string): void {
  const job = getImportJob(id);
  if (!job) return;
  deleteJobZip(job);
  updateImportJob(id, { status: 'cancelled', rawZipPath: null });
}
