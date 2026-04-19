// Background worker that runs the AI classifier over every note in
// an import job and updates the job's plan + stats as it goes.
//
// Architecture: one in-process task per job, no external queue.
// Concurrency cap guards against rate-limit spikes + cost blow-outs;
// the hard per-job call cap is enforced inside the loop.

import type { ImportJob } from './imports';
import { deleteJobZip, getImportJob, updateImportJob } from './imports';
import type { ImportPlan, ParsedNote } from './import-parse';
import {
  classifyImportNote,
  defaultConventions,
  type FolderConventions,
  type ImportClassifyContext,
  type ImportClassifyResult,
} from './ai/import-skill';
import { listCampaigns } from './characters';
import { getDb } from './db';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_CALLS = 500;
const DEFAULT_MAX_TOKENS = 500_000;

/** Per-note shape stored back into plan.notes after analyse. We
 *  extend the ParsedNote with the AI's suggestion + an `accepted`
 *  flag the review UI drives. */
export type PlannedNote = ParsedNote & {
  classification: ImportClassifyResult | null;
  /** AI call status — 'pending' before worker reaches it, 'ok' after
   *  success, 'unclassified' if we ended up treating it as plain due
   *  to retries or schema failures. */
  analyseStatus: 'pending' | 'ok' | 'unclassified' | 'failed';
  analyseError: string | null;
  /** Whether the DM wants this entry included on apply. Defaults to
   *  the AI's confidence threshold; the review UI can flip it. */
  accepted: boolean;
};

export type AnalyseStats = {
  done: number;
  total: number;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  model: string;
  startedAt: number;
  finishedAt: number | null;
  capHit: boolean;
  errors: Array<{ sourcePath: string; message: string }>;
};

// ── In-process job registry ────────────────────────────────────────────

const inFlight = new Map<string, Promise<void>>();
const aborters = new Map<string, AbortController>();

export function isAnalyseRunning(jobId: string): boolean {
  return inFlight.has(jobId);
}

export function abortAnalyse(jobId: string): void {
  aborters.get(jobId)?.abort();
}

export function runAnalyseInBackground(jobId: string): void {
  if (inFlight.has(jobId)) return;
  const ctl = new AbortController();
  aborters.set(jobId, ctl);
  const p = doAnalyse(jobId, ctl.signal)
    .catch((err) => {
      console.error('[import.analyse] unhandled:', err);
      updateImportJob(jobId, {
        status: 'failed',
        stats: {
          fatalError: err instanceof Error ? err.message : String(err),
        },
      });
    })
    .finally(() => {
      inFlight.delete(jobId);
      aborters.delete(jobId);
    });
  inFlight.set(jobId, p);
}

// ── Worker ─────────────────────────────────────────────────────────────

async function doAnalyse(jobId: string, signal: AbortSignal): Promise<void> {
  const job = getImportJob(jobId);
  if (!job) return;
  if (job.status !== 'uploaded' && job.status !== 'analysing') return;

  const rawPlan = job.plan as ImportPlan | null;
  if (!rawPlan) {
    updateImportJob(jobId, {
      status: 'failed',
      stats: { fatalError: 'no parse plan on job' },
    });
    return;
  }
  const plan: ImportPlan = rawPlan;

  const maxCalls = envInt('IMPORT_MAX_AI_CALLS', DEFAULT_MAX_CALLS);
  const maxTokens = envInt('IMPORT_MAX_TOKENS', DEFAULT_MAX_TOKENS);
  const concurrency = envInt('IMPORT_CONCURRENCY', DEFAULT_CONCURRENCY);
  const model = process.env.OPENAI_MODEL ?? 'gpt-5-mini';

  // Hydrate planned notes (ParsedNote -> PlannedNote with analyseStatus=pending).
  const planned: PlannedNote[] = plan.notes.map((n) => ({
    ...n,
    classification: null,
    analyseStatus: 'pending',
    analyseError: null,
    accepted: false,
  }));

  // AI context assembled once — reused across every note in the job.
  const ctx = buildContext(job, planned);

  const stats: AnalyseStats = {
    done: 0,
    total: planned.length,
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    model,
    startedAt: Date.now(),
    finishedAt: null,
    capHit: false,
    errors: [],
  };

  updateImportJob(jobId, { status: 'analysing', stats });

  let nextIdx = 0;

  // Worker loop: spawn up to `concurrency` classify calls; as each
  // finishes, take the next pending note. Stops at hard cap or abort.
  async function worker(): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      if (stats.callCount >= maxCalls) {
        stats.capHit = true;
        return;
      }
      const tokensSoFar =
        stats.inputTokens + stats.outputTokens + stats.reasoningTokens;
      if (tokensSoFar >= maxTokens) {
        stats.capHit = true;
        return;
      }
      const idx = nextIdx++;
      if (idx >= planned.length) return;

      const note = planned[idx]!;
      stats.callCount++;
      try {
        const { result, usage, costUsd } = await classifyImportNote(
          {
            filename: note.basename,
            folderPath: note.sourcePath
              .split('/')
              .slice(0, -1)
              .join('/'),
            content: note.content,
            existingFrontmatter: note.existingFrontmatter,
            context: ctx,
          },
          { signal },
        );
        note.classification = result;
        note.analyseStatus = 'ok';
        note.accepted = result.confidence >= 0.4 && result.kind !== 'plain';
        stats.inputTokens += usage.inputTokens;
        stats.outputTokens += usage.outputTokens;
        stats.reasoningTokens += usage.reasoningTokens;
        stats.costUsd += costUsd;
      } catch (err) {
        if (signal.aborted) return;
        note.analyseStatus = 'failed';
        note.analyseError = err instanceof Error ? err.message : String(err);
        stats.errors.push({
          sourcePath: note.sourcePath,
          message: note.analyseError ?? 'error',
        });
      } finally {
        stats.done++;
      }

      // Flush progress on every 4 completions or on the very last one,
      // so the polling client sees movement without thrashing SQLite.
      if (stats.done % 4 === 0 || stats.done === planned.length) {
        flush(jobId, plan, planned, stats);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );

  stats.finishedAt = Date.now();

  // Final flush — always. Cap-hit or abort leaves `ready` with
  // partial results; the DM sees the capHit flag in the UI.
  const finalStatus = signal.aborted ? 'cancelled' : 'ready';
  if (signal.aborted) deleteJobZip(job);
  flush(jobId, plan, planned, stats, finalStatus);
}

function flush(
  jobId: string,
  originalPlan: ImportPlan,
  planned: PlannedNote[],
  stats: AnalyseStats,
  status?: 'analysing' | 'ready' | 'cancelled',
): void {
  const nextPlan: ImportPlan & { plannedNotes: PlannedNote[] } = {
    ...originalPlan,
    plannedNotes: planned,
  };
  updateImportJob(jobId, {
    plan: nextPlan,
    stats,
    ...(status ? { status } : {}),
  });
}

function buildContext(
  job: ImportJob,
  planned: PlannedNote[],
): ImportClassifyContext {
  const db = getDb();
  const existingVaultPaths = db
    .query<{ path: string }, [string]>(
      'SELECT path FROM notes WHERE group_id = ?',
    )
    .all(job.groupId)
    .map((r) => r.path);

  const existingVaultTags = db
    .query<{ tag: string }, [string]>(
      `SELECT DISTINCT tag FROM tags WHERE group_id = ? ORDER BY tag LIMIT 200`,
    )
    .all(job.groupId)
    .map((r) => r.tag);

  const droppedPaths = planned.map((n) => n.sourcePath);

  // Pick a target campaign. If any of the dropped files live under
  // Campaigns/<name>/, use the first such slug. Otherwise the active
  // world's first campaigns row. Otherwise null — AI will treat as
  // unscoped lore/world content.
  const droppedCampaign = pickCampaignFromPaths(droppedPaths);
  const campaigns = listCampaigns(job.groupId);
  const targetCampaignSlug =
    droppedCampaign ?? campaigns[0]?.slug ?? null;
  const conventions: FolderConventions = defaultConventions(
    targetCampaignSlug,
  );
  // Adjust folder names when the target campaign exists — use its
  // actual folder_path rather than a synthesised one.
  if (targetCampaignSlug) {
    const active = campaigns.find((c) => c.slug === targetCampaignSlug);
    if (active) {
      conventions.campaignRoot = active.folderPath;
      conventions.pcsFolder = `${active.folderPath}/Characters/PCs`;
      conventions.npcsFolder = `${active.folderPath}/Characters/NPCs`;
      conventions.alliesFolder = `${active.folderPath}/Characters/Allies`;
      conventions.villainsFolder = `${active.folderPath}/Characters/Villains`;
      conventions.sessionsFolder = `${active.folderPath}/Sessions`;
      conventions.locationsFolder = `${active.folderPath}/Locations`;
      conventions.itemsFolder = `${active.folderPath}/Items`;
    }
  }

  const knownImageBasenames =
    (job.plan as ImportPlan | null)?.assets.map((a) => a.basename) ?? [];

  return {
    targetCampaignSlug,
    knownNotePaths: [...existingVaultPaths, ...droppedPaths].slice(0, 400),
    knownImageBasenames,
    existingVaultTags,
    conventions,
  };
}

function pickCampaignFromPaths(paths: string[]): string | null {
  for (const p of paths) {
    const m = /^(?:[^/]+\/)?Campaigns\/([^/]+)\//i.exec(p);
    if (m) {
      return slugify(m[1]!);
    }
  }
  return null;
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
