// Background worker that runs the AI classifier over every note in
// an import job and updates the job's plan + stats as it goes.
//
// Architecture: one in-process task per job, no external queue.
// Concurrency cap guards against rate-limit spikes + cost blow-outs;
// the hard per-job call cap is enforced inside the loop.

import type { ImportJob } from './imports';
import { deleteJobZip, getImportJob, updateImportJob } from './imports';
import type { ImportPlan, ParsedNote } from './import-parse';
import { runClassify, type ClassifyInput } from './ai/skills/classify';
import {
  extractAlly,
  extractItem,
  extractLocation,
  extractNpc,
  extractPc,
  extractSession,
  extractVillain,
  type ExtractInput,
  type ExtractResult,
} from './ai/skills/extract';
import {
  defaultConventions,
  type FolderConventions,
  type ImportSkillContext,
} from './ai/skills/common';
import type { ImportClassifyResult } from './ai/skills/types';
import type { TokenUsage } from './ai/pricing';
import { listCampaigns } from './characters';
import { getDb } from './db';
import { slugify } from './compendium';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_CALLS = 500;
const DEFAULT_MAX_TOKENS = 500_000;

// ── Token budget estimation ────────────────────────────────────────────
//
// The budget guard has to price a call BEFORE making it. Checking only
// what has been spent so far lets a single large extract blow past the
// cap by the entire size of that call — and with IMPORT_CONCURRENCY
// workers all clearing the same stale check, by that much times N.
//
// We do not ship a real tokeniser: a BPE table is megabytes of data for
// what is a cost guard, not an accounting system. A character estimate
// is fine as long as it errs high.
//
// Calibration: English prose is ~4 chars/token, but import payloads are
// markdown tables, YAML frontmatter, stat blocks and proper nouns, which
// tokenise closer to 3. We use 3, add the fixed prompt scaffolding each
// skill wraps around the note, reserve room for the completion plus the
// reasoning tokens that are invisible until they are billed, and apply a
// safety factor on top. Over-estimating costs a few unclassified notes
// at the tail of a very large import (the DM sees `capHit` and can raise
// the cap); under-estimating costs real money.

/** Conservative chars-per-token for markdown/YAML import content. */
const CHARS_PER_TOKEN = 3;
/** System prompt + context block (known paths, tags, conventions). */
const PROMPT_OVERHEAD_TOKENS = 2_000;
/** Completion + reasoning headroom for one structured call. */
const OUTPUT_RESERVE_TOKENS = 4_000;
/** Multiplier applied to the whole estimate. */
const ESTIMATE_SAFETY_FACTOR = 1.25;

/** Upper-bound token cost of one classify/extract call over `contentChars`
 *  characters of note body. Deliberately pessimistic — see above. */
export function estimateCallTokens(contentChars: number): number {
  const input =
    Math.ceil(Math.max(0, contentChars) / CHARS_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS;
  return Math.ceil((input + OUTPUT_RESERVE_TOKENS) * ESTIMATE_SAFETY_FACTOR);
}

/** Total tokens billed so far on this job. */
export function tokensSpent(stats: Pick<
  AnalyseStats,
  'inputTokens' | 'outputTokens' | 'reasoningTokens'
>): number {
  return stats.inputTokens + stats.outputTokens + stats.reasoningTokens;
}

/** True when a call estimated at `estimate` tokens still fits in the cap.
 *  The estimate itself is the headroom: we refuse the call whose own
 *  projected cost would cross `maxTokens`, rather than noticing after. */
export function hasTokenBudget(
  spent: number,
  estimate: number,
  maxTokens: number,
): boolean {
  return spent + estimate <= maxTokens;
}

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
  const p = runAnalyse(jobId, ctl.signal)
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

/** Run the analyse pass to completion. `runAnalyseInBackground` is the
 *  fire-and-forget wrapper the route uses; this is exported so tests can
 *  await the same work. */
export async function runAnalyse(jobId: string, signal: AbortSignal): Promise<void> {
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
      const idx = nextIdx++;
      if (idx >= planned.length) return;

      const note = planned[idx]!;

      // Budget check BEFORE the call, priced on the call we are about to
      // make. The note keeps analyseStatus 'pending' so the review UI can
      // tell "we ran out of budget here" from "this one failed".
      const estimate = estimateCallTokens(note.content.length);
      if (!hasTokenBudget(tokensSpent(stats), estimate, maxTokens)) {
        stats.capHit = true;
        return;
      }

      try {
        const classifyInput: ClassifyInput = {
          filename: note.basename,
          folderPath: note.sourcePath.split('/').slice(0, -1).join('/'),
          content: note.content,
          existingFrontmatter: note.existingFrontmatter,
          context: ctx,
        };

        // Step 1 — classify. One OpenAI call; decides kind + path +
        // common metadata.
        stats.callCount++;
        const classified = await runClassify(classifyInput, { signal });
        addUsage(stats, classified.usage, classified.costUsd);

        // Step 2 — per-kind extract. Skipped for kind=plain or
        // kind=lore (no structured sheet). Call the specific
        // extractor so each one can carry its own narrow prompt.
        let extract: { result: ExtractResult; usage: TokenUsage; costUsd: number } | null = null;
        // Re-check both caps against the freshly-billed classify usage —
        // the extract is a second call of comparable size and must be
        // priced on its own before it runs.
        if (
          stats.callCount < maxCalls &&
          hasTokenBudget(tokensSpent(stats), estimate, maxTokens)
        ) {
          const extractInput: ExtractInput = {
            ...classifyInput,
            displayName: classified.result.displayName,
          };
          const extractor = pickExtractor(classified.result);
          if (extractor) {
            stats.callCount++;
            extract = await extractor(extractInput, { signal });
            addUsage(stats, extract.usage, extract.costUsd);
          }
        } else {
          stats.capHit = true;
        }

        const merged: ImportClassifyResult = {
          ...classified.result,
          sheet: extract?.result.sheet ?? {},
        };
        note.classification = merged;
        note.analyseStatus = 'ok';
        note.accepted =
          merged.confidence >= 0.4 && merged.kind !== 'plain';
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

function addUsage(
  stats: AnalyseStats,
  usage: TokenUsage,
  cost: number,
): void {
  stats.inputTokens += usage.inputTokens;
  stats.outputTokens += usage.outputTokens;
  stats.reasoningTokens += usage.reasoningTokens;
  stats.costUsd += cost;
}

function pickExtractor(
  classified: { kind: string; role: string | null },
): ((input: ExtractInput, opts: { signal?: AbortSignal }) => Promise<{
  result: ExtractResult;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}>) | null {
  if (classified.kind === 'character') {
    switch (classified.role) {
      case 'pc':
        return extractPc;
      case 'ally':
        return extractAlly;
      case 'villain':
        return extractVillain;
      case 'npc':
      default:
        return extractNpc;
    }
  }
  switch (classified.kind) {
    case 'location':
      return extractLocation;
    case 'item':
      return extractItem;
    case 'session':
      return extractSession;
    default:
      return null; // lore + plain skip extract
  }
}

function buildContext(
  job: ImportJob,
  planned: PlannedNote[],
): ImportSkillContext {
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
      conventions.campaignRoot     = active.folderPath;
      conventions.charactersFolder   = `${active.folderPath}/Characters`;
      conventions.peopleFolder       = `${active.folderPath}/People`;
      conventions.enemiesFolder      = `${active.folderPath}/Enemies`;
      conventions.adventureLogFolder = `${active.folderPath}/Adventure Log`;
      conventions.placesFolder       = `${active.folderPath}/Places`;
      conventions.lootFolder         = `${active.folderPath}/Loot`;
      conventions.creaturesFolder    = `${active.folderPath}/Creatures`;
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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
