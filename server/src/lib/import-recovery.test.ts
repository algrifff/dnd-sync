// H11 — import jobs must be durable across a process restart, and the
// entities phase must not duplicate notes when a crashed run is retried.
// M8 — the analyse token cap must refuse a call that would overrun it,
// rather than noticing after the call has already been billed.
//
// Everything here runs against a real on-disk SQLite DB (setupTestDb)
// and real ZIPs written to a temp dir. No mocking, and — importantly —
// no OPENAI_API_KEY: the AI skills throw immediately without one, which
// exercises the orchestrator's own fallback paths (heuristic campaign
// grouping, classify-failure → plain note) end to end.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import {
  createImportJob,
  getImportJob,
  importsDir,
  updateImportJob,
  writeJobZip,
} from './imports';
import { parseImportZip } from './import-parse';
import {
  INTERRUPTED_REASON,
  STALLED_REASON,
  recoverImportJobs,
  runOrchestration,
  sweepOrphanImportZips,
  sweepStalledImportJobs,
  type OrchestrationState,
} from './import-orchestrate';
import {
  estimateCallTokens,
  hasTokenBudget,
  runAnalyse,
  type AnalyseStats,
} from './import-analyse';

// ── Fixtures ───────────────────────────────────────────────────────────

const GROUP_ID = 'grp-import-recovery';
const USER_ID = 'usr-import-recovery';

function seedTenant(): void {
  const db = getDb();
  const now = Date.now();
  db.query(`INSERT OR IGNORE INTO groups (id, name, created_at) VALUES (?, ?, ?)`)
    .run(GROUP_ID, 'Recovery World', now);
  db.query(
    `INSERT OR IGNORE INTO users
       (id, username, password_hash, display_name, accent_color, created_at)
     VALUES (?, ?, 'x', ?, '#fff', ?)`,
  ).run(USER_ID, 'recovery-dm', 'Recovery DM', now);
  db.query(
    `INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at)
     VALUES (?, ?, 'admin', ?)`,
  ).run(GROUP_ID, USER_ID, now);
}

/** Write a real ZIP of markdown notes and return its path. */
function makeZip(jobId: string, files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [path, body] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(body, 'utf-8'));
  }
  return writeJobZip(jobId, new Uint8Array(zip.toBuffer()));
}

/** A job in the entities phase with the campaign question already
 *  answered, so `runOrchestration` runs assets → entities → quality
 *  without ever blocking on the DM. */
function seedEntitiesJob(files: Record<string, string>): {
  jobId: string;
  zipPath: string;
} {
  const job = createImportJob({
    groupId: GROUP_ID,
    createdBy: USER_ID,
    rawZipPath: 'placeholder',
  });
  const zipPath = makeZip(job.id, files);
  const plan = parseImportZip(zipPath);
  const orchestration: OrchestrationState = {
    phase: 'entities',
    assetMap: {},
    entityMap: {},
    // Empty prefix = catch-all; null root = World Lore (no campaign),
    // which keeps the fixture free of campaign skeleton side effects.
    campaignAssignments: [{ name: '', slug: '', root: null, sourcePrefix: '' }],
    conversationHistory: [],
    summary: null,
    phaseLog: [],
    currentActivity: null,
  };
  updateImportJob(job.id, {
    status: 'orchestrating_entities',
    rawZipPath: zipPath,
    plan: { ...plan, orchestration },
  });
  return { jobId: job.id, zipPath };
}

function loadOrch(jobId: string): OrchestrationState {
  const plan = getImportJob(jobId)?.plan as { orchestration?: OrchestrationState } | null;
  if (!plan?.orchestration) throw new Error('no orchestration state on job');
  return plan.orchestration;
}

function notePaths(): string[] {
  return getDb()
    .query<{ path: string }, [string]>(
      'SELECT path FROM notes WHERE group_id = ? ORDER BY path',
    )
    .all(GROUP_ID)
    .map((r) => r.path);
}

// The orchestrator's fallbacks only engage when there is no API key.
let savedKey: string | undefined;

beforeAll(() => {
  setupTestDb();
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  teardownTestDb();
});

beforeEach(() => {
  const db = getDb();
  db.query('DELETE FROM import_jobs').run();
  db.query('DELETE FROM notes').run();
  db.query('DELETE FROM folder_markers').run();
  // Fresh imports dir per test — the sweep counts files, so leftovers
  // from a previous case would leak into its result.
  rmSync(importsDir(), { recursive: true, force: true });
  mkdirSync(importsDir(), { recursive: true });
  seedTenant();
});

// ══ 1. Startup recovery ════════════════════════════════════════════════

describe('recoverImportJobs — jobs orphaned by a restart', () => {
  it('fails a job stranded mid-orchestration and reclaims its ZIP', () => {
    const { jobId, zipPath } = seedEntitiesJob({ 'Alpha.md': '# Alpha\n' });
    expect(existsSync(zipPath)).toBe(true);

    const report = recoverImportJobs();

    expect(report.interrupted).toContain(jobId);
    const job = getImportJob(jobId)!;
    expect(job.status).toBe('failed');
    expect(job.rawZipPath).toBeNull();
    const stats = job.stats as Record<string, unknown>;
    expect(stats.fatalError).toBe(INTERRUPTED_REASON);
    expect(stats.interruptedStatus).toBe('orchestrating_entities');
    // The ZIP is the one durable resource a crash leaks — it must go.
    expect(existsSync(zipPath)).toBe(false);
  });

  it('fails a job stranded in waiting_for_answer', () => {
    const { jobId } = seedEntitiesJob({ 'Alpha.md': '# Alpha\n' });
    updateImportJob(jobId, { status: 'waiting_for_answer' });

    recoverImportJobs();

    const job = getImportJob(jobId)!;
    expect(job.status).toBe('failed');
    expect((job.stats as Record<string, unknown>).interruptedStatus).toBe(
      'waiting_for_answer',
    );
  });

  it('preserves the orchestration state so applied notes are auditable', () => {
    const { jobId } = seedEntitiesJob({ 'Alpha.md': '# Alpha\n' });
    const orch = loadOrch(jobId);
    orch.entityMap['Alpha.md'] = 'World Lore/alpha.md';
    const plan = getImportJob(jobId)!.plan as Record<string, unknown>;
    updateImportJob(jobId, { plan: { ...plan, orchestration: orch } });

    recoverImportJobs();

    expect(loadOrch(jobId).entityMap).toEqual({ 'Alpha.md': 'World Lore/alpha.md' });
  });

  it('leaves a fresh uploaded job alone but expires a stale one', () => {
    const fresh = createImportJob({
      groupId: GROUP_ID,
      createdBy: USER_ID,
      rawZipPath: makeZip('fresh-job', { 'A.md': '# A\n' }),
    });
    const stale = createImportJob({
      groupId: GROUP_ID,
      createdBy: USER_ID,
      rawZipPath: makeZip('stale-job', { 'B.md': '# B\n' }),
    });
    const staleZip = getImportJob(stale.id)!.rawZipPath!;
    // Age it past the TTL by rewriting updated_at directly.
    getDb()
      .query('UPDATE import_jobs SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 30 * 24 * 60 * 60_000, stale.id);

    const report = recoverImportJobs();

    expect(getImportJob(fresh.id)!.status).toBe('uploaded');
    expect(report.expired).toEqual([stale.id]);
    expect(getImportJob(stale.id)!.status).toBe('cancelled');
    expect(existsSync(staleZip)).toBe(false);
  });

  it('does not touch terminal jobs', () => {
    const done = createImportJob({
      groupId: GROUP_ID,
      createdBy: USER_ID,
      rawZipPath: makeZip('done-job', { 'A.md': '# A\n' }),
    });
    updateImportJob(done.id, { status: 'applied', rawZipPath: null });

    const report = recoverImportJobs();

    expect(report.interrupted).not.toContain(done.id);
    expect(getImportJob(done.id)!.status).toBe('applied');
  });
});

// ══ 2. Stalled-job timeout ═════════════════════════════════════════════

describe('sweepStalledImportJobs — the DM never answered', () => {
  it('fails a waiting_for_answer job past the timeout, spares a fresh one', () => {
    const { jobId: stalled } = seedEntitiesJob({ 'Alpha.md': '# Alpha\n' });
    const { jobId: fresh } = seedEntitiesJob({ 'Beta.md': '# Beta\n' });
    updateImportJob(stalled, { status: 'waiting_for_answer' });
    updateImportJob(fresh, { status: 'waiting_for_answer' });
    getDb()
      .query('UPDATE import_jobs SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 60 * 60_000, stalled);

    const failed = sweepStalledImportJobs({ timeoutMs: 30 * 60_000 });

    expect(failed).toEqual([stalled]);
    expect(getImportJob(stalled)!.status).toBe('failed');
    expect((getImportJob(stalled)!.stats as Record<string, unknown>).fatalError).toBe(
      STALLED_REASON,
    );
    expect(getImportJob(stalled)!.rawZipPath).toBeNull();
    expect(getImportJob(fresh)!.status).toBe('waiting_for_answer');
  });
});

// ══ 3. Orphaned ZIP cleanup ════════════════════════════════════════════

describe('sweepOrphanImportZips', () => {
  const stamped: string[] = [];

  /** Backdate mtime past the grace window so the sweep considers it. */
  function age(path: string): string {
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(path, old, old);
    stamped.push(path);
    return path;
  }

  afterEach(() => {
    stamped.length = 0;
  });

  it('removes a ZIP no job row points at', () => {
    const orphan = join(importsDir(), 'orphan-abc.zip');
    writeFileSync(orphan, 'not-really-a-zip');
    age(orphan);

    expect(sweepOrphanImportZips()).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it('keeps a ZIP that a live job still references', () => {
    const job = createImportJob({
      groupId: GROUP_ID,
      createdBy: USER_ID,
      rawZipPath: makeZip('live-job', { 'A.md': '# A\n' }),
    });
    const zip = age(getImportJob(job.id)!.rawZipPath!);

    sweepOrphanImportZips();

    expect(existsSync(zip)).toBe(true);
  });

  it('spares a just-written ZIP — the upload route inserts its row after writing bytes', () => {
    const dir = importsDir();
    const racing = join(dir, 'racing-upload.zip');
    writeFileSync(racing, 'bytes-on-disk-row-not-yet-inserted');

    sweepOrphanImportZips();

    expect(existsSync(racing)).toBe(true);
  });

  it('reclaims the ZIP of a job that already went terminal', () => {
    const job = createImportJob({
      groupId: GROUP_ID,
      createdBy: USER_ID,
      rawZipPath: makeZip('terminal-job', { 'A.md': '# A\n' }),
    });
    const zip = age(getImportJob(job.id)!.rawZipPath!);
    // Simulate the old apply-route failure path: status flipped, blob left.
    updateImportJob(job.id, { status: 'failed', rawZipPath: null });

    expect(sweepOrphanImportZips()).toBe(1);
    expect(existsSync(zip)).toBe(false);
  });
});

// ══ 4. Entities checkpoint ═════════════════════════════════════════════

describe('entities phase checkpoint', () => {
  it('does not re-create entities a previous attempt already wrote', async () => {
    const { jobId } = seedEntitiesJob({
      'Alpha.md': '# Alpha\n\nA note about Alpha.\n',
      'Beta.md': '# Beta\n\nA note about Beta.\n',
    });

    // First attempt — runs to completion.
    await runOrchestration(jobId, new AbortController().signal);

    const afterFirst = notePaths();
    const mapAfterFirst = loadOrch(jobId).entityMap;
    expect(Object.keys(mapAfterFirst).sort()).toEqual(['Alpha.md', 'Beta.md']);
    expect(afterFirst).toContain('World Lore/alpha.md');
    expect(afterFirst).toContain('World Lore/beta.md');

    // Simulate a crash *after* the writes but before the job went
    // terminal: the row is back in the entities phase with the same
    // checkpointed entityMap, and the ZIP is still on disk.
    const zipPath = makeZip(jobId, {
      'Alpha.md': '# Alpha\n\nA note about Alpha.\n',
      'Beta.md': '# Beta\n\nA note about Beta.\n',
    });
    const plan = getImportJob(jobId)!.plan as Record<string, unknown>;
    const orch = loadOrch(jobId);
    orch.phase = 'entities';
    updateImportJob(jobId, {
      status: 'orchestrating_entities',
      rawZipPath: zipPath,
      plan: { ...plan, orchestration: orch },
    });

    // Second attempt — must be a no-op for the already-written notes.
    await runOrchestration(jobId, new AbortController().signal);

    const afterSecond = notePaths();
    expect(afterSecond).toEqual(afterFirst);
    // The specific regression: without the checkpoint the batch
    // de-duplicator sees the canonical path as taken and writes a copy.
    expect(afterSecond).not.toContain('World Lore/alpha-2.md');
    expect(afterSecond).not.toContain('World Lore/beta-2.md');
    expect(Object.keys(loadOrch(jobId).entityMap).sort()).toEqual([
      'Alpha.md',
      'Beta.md',
    ]);
  });

  it('picks up only the notes a partial run had not reached', async () => {
    const { jobId } = seedEntitiesJob({
      'Alpha.md': '# Alpha\n',
      'Beta.md': '# Beta\n',
    });

    // Pretend Alpha landed before the crash — seed the checkpoint by hand
    // and write the note it refers to.
    const orch = loadOrch(jobId);
    orch.entityMap['Alpha.md'] = 'World Lore/alpha.md';
    const plan = getImportJob(jobId)!.plan as Record<string, unknown>;
    updateImportJob(jobId, { plan: { ...plan, orchestration: orch } });

    await runOrchestration(jobId, new AbortController().signal);

    const paths = notePaths();
    expect(paths).toContain('World Lore/beta.md');
    // Alpha was checkpointed, so it was skipped entirely — no note, no
    // suffixed duplicate.
    expect(paths).not.toContain('World Lore/alpha-2.md');
    expect(getImportJob(jobId)!.status).toBe('applied');
  });

  it('reclaims the ZIP on a successful run', async () => {
    const { jobId, zipPath } = seedEntitiesJob({ 'Alpha.md': '# Alpha\n' });

    await runOrchestration(jobId, new AbortController().signal);

    expect(getImportJob(jobId)!.status).toBe('applied');
    expect(getImportJob(jobId)!.rawZipPath).toBeNull();
    expect(existsSync(zipPath)).toBe(false);
  });
});

// ══ 5. M8 — token budget is checked before the call ════════════════════

describe('analyse token budget', () => {
  it('estimates a call from its content size, erring high', () => {
    // Empty note still costs prompt scaffolding + output reserve.
    expect(estimateCallTokens(0)).toBeGreaterThan(1_000);
    // A 300k-char note must estimate well above a naive 4 chars/token.
    expect(estimateCallTokens(300_000)).toBeGreaterThan(300_000 / 4);
    expect(estimateCallTokens(30_000)).toBeGreaterThan(estimateCallTokens(3_000));
    expect(estimateCallTokens(-5)).toBe(estimateCallTokens(0));
  });

  it('refuses a call whose own cost would cross the cap', () => {
    // Spent-so-far is under the cap — the old check would have allowed
    // this — but the call itself does not fit.
    expect(hasTokenBudget(490_000, 20_000, 500_000)).toBe(false);
    expect(hasTokenBudget(490_000, 5_000, 500_000)).toBe(true);
    expect(hasTokenBudget(0, 500_001, 500_000)).toBe(false);
  });

  it('stops the worker before it bills an over-budget call', async () => {
    const job = createImportJob({
      groupId: GROUP_ID,
      createdBy: USER_ID,
      rawZipPath: makeZip('budget-job', { 'Big.md': `# Big\n\n${'x'.repeat(40_000)}` }),
    });
    const plan = parseImportZip(getImportJob(job.id)!.rawZipPath!);
    expect(plan.notes).toHaveLength(1);
    updateImportJob(job.id, { plan });

    // Budget is non-zero but far smaller than this note's estimate, so
    // the pre-flight check must refuse it. Under the old "tokens spent so
    // far" check, spent = 0 < cap and the call would go out (and, with no
    // API key, come back as a hard failure).
    const prev = process.env.IMPORT_MAX_TOKENS;
    process.env.IMPORT_MAX_TOKENS = '5000';
    try {
      await runAnalyse(job.id, new AbortController().signal);
    } finally {
      if (prev === undefined) delete process.env.IMPORT_MAX_TOKENS;
      else process.env.IMPORT_MAX_TOKENS = prev;
    }

    const stats = getImportJob(job.id)!.stats as AnalyseStats;
    expect(stats.capHit).toBe(true);
    expect(stats.callCount).toBe(0);
    expect(stats.errors).toEqual([]);

    const analysed = (getImportJob(job.id)!.plan as {
      plannedNotes: Array<{ analyseStatus: string }>;
    }).plannedNotes;
    expect(analysed[0]!.analyseStatus).toBe('pending');
  });

  it('lets a call through when the budget genuinely covers it', async () => {
    const job = createImportJob({
      groupId: GROUP_ID,
      createdBy: USER_ID,
      rawZipPath: makeZip('roomy-job', { 'Small.md': '# Small\n' }),
    });
    updateImportJob(job.id, { plan: parseImportZip(getImportJob(job.id)!.rawZipPath!) });

    await runAnalyse(job.id, new AbortController().signal);

    // No API key, so the call fails — the point is that it was *attempted*
    // rather than refused, proving the guard is not simply always-on.
    const stats = getImportJob(job.id)!.stats as AnalyseStats;
    expect(stats.capHit).toBe(false);
    expect(stats.callCount).toBe(1);
    expect(stats.errors).toHaveLength(1);
  });
});

// Guard against the fixture silently drifting: the imports dir must be
// inside the per-test DATA_DIR, never the developer's real volume.
it('writes fixtures under the test DATA_DIR', () => {
  expect(importsDir().startsWith(process.env.DATA_DIR!)).toBe(true);
  expect(readdirSync(importsDir())).toBeDefined();
});
