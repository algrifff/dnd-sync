// Smart Import orchestrator — multi-pass AI import.
//
// Runs six sequential phases against an import job's ZIP:
//   0. Assets   — write all images/media to the asset store
//   1. Campaign — determine (or ask DM to create) the target campaign
//   2. Entities — classify + extract + write every note to its canonical path
//   3. Quality  — re-derive indexes, build summary
//
// DM questions are surfaced through an in-process chat channel: the
// worker pauses, appends a message to conversationHistory in plan_json,
// flips the job to `waiting_for_answer`, then awaits a Promise resolved
// by the /api/import/:id/answer endpoint.

import { existsSync } from 'node:fs';
import AdmZip from 'adm-zip';
import YAML from 'yaml';
import { getDb } from './db';
import {
  getImportJob,
  updateImportJob,
  deleteJobZip,
  type ImportJob,
  type ImportStatus,
} from './imports';
import type { ImportPlan } from './import-parse';
import { writeNote, commitAsset, composeMarkdown } from './import-apply';
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
} from './ai/skills/extract';
import {
  defaultConventions,
  type ImportSkillContext,
} from './ai/skills/common';
import { canonicalPath, canonicalFolder, nameToSlug, type EntityKind } from './ai/paths';
import { listCampaigns } from './characters';
import { deriveAllIndexes } from './derive-indexes';

// ── Types ──────────────────────────────────────────────────────────────

export type OrchestrationState = {
  phase: 'assets' | 'campaign' | 'entities' | 'quality' | 'done';
  /** basename.toLowerCase() → vault path written to DB */
  assetMap: Record<string, string>;
  /** sourcePath → final note path in DB */
  entityMap: Record<string, string>;
  campaignSlug: string | null;
  campaignRoot: string | null;
  conversationHistory: Array<{
    role: 'assistant' | 'user';
    content: string;
    timestamp: number;
  }>;
  summary: string | null;
  phaseLog: Array<{ phase: string; completedAt: number; count?: number }>;
};

type PlanWithOrch = ImportPlan & { orchestration?: OrchestrationState };

// ── In-process registries ──────────────────────────────────────────────

const inFlight = new Map<string, Promise<void>>();
const aborters = new Map<string, AbortController>();
const pendingAnswers = new Map<string, (reply: string) => void>();

export function isOrchestrationRunning(jobId: string): boolean {
  return inFlight.has(jobId);
}

export function abortOrchestration(jobId: string): void {
  aborters.get(jobId)?.abort();
  pendingAnswers.get(jobId)?.('__aborted__');
  pendingAnswers.delete(jobId);
}

export function startOrchestration(jobId: string): void {
  if (inFlight.has(jobId)) return;
  const ctl = new AbortController();
  aborters.set(jobId, ctl);
  const p = doOrchestrate(jobId, ctl.signal)
    .catch((err: unknown) => {
      if (ctl.signal.aborted) return;
      console.error('[import.orchestrate] unhandled:', err);
      const job = getImportJob(jobId);
      const plan = job?.plan as PlanWithOrch | null;
      updateImportJob(jobId, {
        status: 'failed',
        plan: plan ?? undefined,
        stats: { fatalError: err instanceof Error ? err.message : String(err) },
      });
    })
    .finally(() => {
      inFlight.delete(jobId);
      aborters.delete(jobId);
    });
  inFlight.set(jobId, p);
}

/** Called by the /answer endpoint when the DM submits a reply. */
export function resolveDmQuestion(jobId: string, reply: string): boolean {
  const resolver = pendingAnswers.get(jobId);
  if (!resolver) return false;
  pendingAnswers.delete(jobId);

  // Append the DM's message to the conversation history.
  const job = getImportJob(jobId);
  if (job) {
    const plan = job.plan as PlanWithOrch | null;
    if (plan?.orchestration) {
      plan.orchestration.conversationHistory.push({
        role: 'user',
        content: reply,
        timestamp: Date.now(),
      });
      updateImportJob(jobId, { plan });
    }
  }

  resolver(reply);
  return true;
}

// ── Worker ─────────────────────────────────────────────────────────────

async function doOrchestrate(jobId: string, signal: AbortSignal): Promise<void> {
  const job = getImportJob(jobId);
  if (!job) return;
  if (job.status !== 'uploaded' && job.status !== 'ready') return;

  const rawPlan = job.plan as ImportPlan | null;
  if (!rawPlan) {
    updateImportJob(jobId, { status: 'failed', stats: { fatalError: 'no parse plan on job' } });
    return;
  }
  if (!job.rawZipPath || !existsSync(job.rawZipPath)) {
    updateImportJob(jobId, { status: 'failed', stats: { fatalError: 'raw zip missing — cancel and re-upload' } });
    return;
  }

  const zip = new AdmZip(job.rawZipPath);
  const entryByPath = new Map<string, AdmZip.IZipEntry>();
  for (const e of zip.getEntries()) {
    entryByPath.set(e.entryName.replace(/\\/g, '/'), e);
  }

  // Resume or initialise orchestration state.
  const plan = rawPlan as PlanWithOrch;
  const orch: OrchestrationState = plan.orchestration ?? {
    phase: 'assets',
    assetMap: {},
    entityMap: {},
    campaignSlug: null,
    campaignRoot: null,
    conversationHistory: [],
    summary: null,
    phaseLog: [],
  };

  const saveState = (status: ImportStatus): void => {
    updateImportJob(jobId, {
      status,
      plan: { ...rawPlan, orchestration: orch },
    });
  };

  // Phase 0 — Assets
  if (orch.phase === 'assets') {
    saveState('orchestrating_assets');
    runAssetsPhase(job, orch, rawPlan, entryByPath);
    orch.phaseLog.push({ phase: 'assets', completedAt: Date.now(), count: Object.keys(orch.assetMap).length });
    orch.phase = 'campaign';
    saveState('orchestrating_campaign');
  }

  if (signal.aborted) return;

  // Phase 1 — Campaign
  if (orch.phase === 'campaign') {
    await runCampaignPhase(jobId, job, orch, rawPlan, signal);
    if (signal.aborted) return;
    orch.phaseLog.push({ phase: 'campaign', completedAt: Date.now() });
    orch.phase = 'entities';
    saveState('orchestrating_entities');
  }

  // Phase 2 — Entities
  if (orch.phase === 'entities') {
    await runEntitiesPhase(jobId, job, orch, rawPlan, entryByPath, signal);
    if (signal.aborted) return;
    orch.phaseLog.push({ phase: 'entities', completedAt: Date.now(), count: Object.keys(orch.entityMap).length });
    orch.phase = 'quality';
    saveState('orchestrating_quality');
  }

  // Phase 3 — Quality
  if (orch.phase === 'quality') {
    runQualityPhase(job, orch);
    orch.phaseLog.push({ phase: 'quality', completedAt: Date.now() });
    orch.phase = 'done';
  }

  deleteJobZip(job);
  updateImportJob(jobId, {
    status: 'applied',
    rawZipPath: null,
    plan: { ...rawPlan, orchestration: orch },
    stats: { orchestratedAt: Date.now(), phaseLog: orch.phaseLog },
  });
}

// ── Phase 0: Assets ────────────────────────────────────────────────────

function runAssetsPhase(
  job: ImportJob,
  orch: OrchestrationState,
  rawPlan: ImportPlan,
  entryByPath: Map<string, AdmZip.IZipEntry>,
): void {
  for (const asset of rawPlan.assets) {
    const entry = entryByPath.get(asset.sourcePath);
    if (!entry) continue;
    const folder = asset.mime?.startsWith('image/') ? 'Assets/Portraits' : 'Assets';
    const vaultPath = `${folder}/${asset.basename}`;
    try {
      commitAsset(job, entry.getData(), vaultPath);
      orch.assetMap[asset.basename.toLowerCase()] = vaultPath;
    } catch (err) {
      console.warn('[orchestrate.assets] failed to commit', asset.basename, err);
    }
  }
}

// ── Phase 1: Campaign ──────────────────────────────────────────────────

async function runCampaignPhase(
  jobId: string,
  job: ImportJob,
  orch: OrchestrationState,
  rawPlan: ImportPlan,
  signal: AbortSignal,
): Promise<void> {
  if (orch.campaignSlug !== null || orch.campaignRoot !== null) return; // resumed

  const campaigns = listCampaigns(job.groupId);
  const sourcePaths = rawPlan.notes.map((n) => n.sourcePath);

  // Check if source paths already suggest an existing campaign.
  const detectedSlug = pickCampaignSlugFromPaths(sourcePaths);
  if (detectedSlug) {
    const match = campaigns.find((c) => c.slug === detectedSlug);
    if (match) {
      orch.campaignSlug = match.slug;
      orch.campaignRoot = match.folderPath;
      return;
    }
  }

  const n = rawPlan.notes.length;

  if (campaigns.length === 0) {
    const suggestedName = detectedSlug
      ? detectedSlug.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
      : 'My Campaign';

    const reply = await askDmChat(
      jobId,
      rawPlan,
      orch,
      `I'm about to import **${n} note${n !== 1 ? 's' : ''}**. There are no campaigns in this world yet.\n\n` +
      `Should I create a new campaign?\n\n` +
      `• Suggested name: **"${suggestedName}"**\n` +
      `• Reply with a campaign name to create one\n` +
      `• Reply **"no"** to import as world-level notes (no campaign)`,
      signal,
    );
    if (signal.aborted) return;

    if (/^no\b/i.test(reply.trim())) {
      orch.campaignSlug = null;
      orch.campaignRoot = null;
    } else {
      const name = reply.trim().replace(/^["']|["']$/g, '') || suggestedName;
      const slug = slugify(name);
      orch.campaignSlug = slug;
      orch.campaignRoot = `Campaigns/${slug}`;
      createCampaignSkeleton(job, name, slug);
    }
    return;
  }

  if (campaigns.length === 1) {
    const camp = campaigns[0]!;
    const reply = await askDmChat(
      jobId,
      rawPlan,
      orch,
      `I'm about to import **${n} note${n !== 1 ? 's' : ''}**. I found one existing campaign: **"${camp.name}"**.\n\n` +
      `What should I do?\n` +
      `1. Add to **"${camp.name}"**\n` +
      `2. Create a new campaign (reply with its name)\n` +
      `3. Import as world-level notes`,
      signal,
    );
    if (signal.aborted) return;

    const t = reply.trim();
    if (t === '1' || t.toLowerCase().includes(camp.name.toLowerCase())) {
      orch.campaignSlug = camp.slug;
      orch.campaignRoot = camp.folderPath;
    } else if (t === '3' || /world|no campaign/i.test(t)) {
      orch.campaignSlug = null;
      orch.campaignRoot = null;
    } else {
      const name = t.replace(/^2[.\s]+/, '').replace(/^["']|["']$/g, '') || 'New Campaign';
      const slug = slugify(name);
      orch.campaignSlug = slug;
      orch.campaignRoot = `Campaigns/${slug}`;
      createCampaignSkeleton(job, name, slug);
    }
    return;
  }

  // Multiple campaigns — let DM pick.
  const list = campaigns.map((c, i) => `${i + 1}. **"${c.name}"**`).join('\n');
  const newIdx = campaigns.length + 1;
  const worldIdx = campaigns.length + 2;

  const reply = await askDmChat(
    jobId,
    rawPlan,
    orch,
    `I'm about to import **${n} note${n !== 1 ? 's' : ''}**. Which campaign should I use?\n\n` +
    `${list}\n${newIdx}. Create a new campaign (reply with its name)\n${worldIdx}. World-level notes (no campaign)`,
    signal,
  );
  if (signal.aborted) return;

  const t = reply.trim();
  const idx = parseInt(t, 10) - 1;
  if (!isNaN(idx) && idx >= 0 && idx < campaigns.length) {
    const camp = campaigns[idx]!;
    orch.campaignSlug = camp.slug;
    orch.campaignRoot = camp.folderPath;
  } else if (t === String(worldIdx) || /world|no campaign/i.test(t)) {
    orch.campaignSlug = null;
    orch.campaignRoot = null;
  } else {
    const name = t.replace(/^\d+[.\s]+/, '').replace(/^["']|["']$/g, '') || 'New Campaign';
    const slug = slugify(name);
    orch.campaignSlug = slug;
    orch.campaignRoot = `Campaigns/${slug}`;
    createCampaignSkeleton(job, name, slug);
  }
}

function createCampaignSkeleton(job: ImportJob, name: string, slug: string): void {
  // Writing a note at Campaigns/{slug}/index.md triggers campaign
  // auto-registration in deriveAllIndexes.
  const fm = { kind: 'note', title: name };
  writeNote({
    groupId: job.groupId,
    userId: job.createdBy,
    path: `Campaigns/${slug}/index.md`,
    markdown: composeMarkdown(fm, `# ${name}\n`),
    frontmatter: fm,
    isUpdate: false,
  });
}

// ── Phase 2: Entities ──────────────────────────────────────────────────

async function runEntitiesPhase(
  jobId: string,
  job: ImportJob,
  orch: OrchestrationState,
  rawPlan: ImportPlan,
  entryByPath: Map<string, AdmZip.IZipEntry>,
  signal: AbortSignal,
): Promise<void> {
  const ctx = buildClassifyContext(job, rawPlan, orch);
  const concurrency = 4;
  const notes = rawPlan.notes;
  let nextIdx = 0;

  type ClassifiedNote = {
    sourcePath: string;
    kind: string;
    role: string | null;
    displayName: string;
    canonicalPath: string;
    confidence: number;
    sheet: Record<string, unknown>;
    tags: string[];
    wikilinks: Array<{ anchorText: string; target: string }>;
    portrait: string | null;
    body: string;
    existingFrontmatter: Record<string, unknown>;
  };

  const confident: ClassifiedNote[] = [];
  const ambiguous: ClassifiedNote[] = [];

  async function classifyWorker(): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const idx = nextIdx++;
      if (idx >= notes.length) return;
      const note = notes[idx]!;

      const entry = entryByPath.get(note.sourcePath);
      const rawContent = entry ? entry.getData().toString('utf-8') : '';
      const body = splitBody(rawContent);

      try {
        const classifyInput: ClassifyInput = {
          filename: note.basename,
          folderPath: note.sourcePath.split('/').slice(0, -1).join('/'),
          content: note.content,
          existingFrontmatter: note.existingFrontmatter,
          context: ctx,
        };

        const { result } = await runClassify(classifyInput, { signal });
        if (signal.aborted) return;

        let sheet: Record<string, unknown> = {};
        const extractor = pickExtractor(result);
        if (extractor) {
          const extractInput: ExtractInput = { ...classifyInput, displayName: result.displayName };
          const extracted = await extractor(extractInput, { signal });
          if (!signal.aborted) sheet = extracted.result.sheet ?? {};
        }

        // Resolve portrait against the asset map from Phase 0.
        let portrait: string | null = null;
        if (result.portraitImage) {
          portrait = orch.assetMap[result.portraitImage.toLowerCase()] ?? null;
        }

        const cn: ClassifiedNote = {
          sourcePath: note.sourcePath,
          kind: result.kind,
          role: result.role,
          displayName: result.displayName,
          canonicalPath: result.canonicalPath,
          confidence: result.confidence,
          sheet,
          tags: result.tags,
          wikilinks: result.wikilinks,
          portrait,
          body,
          existingFrontmatter: note.existingFrontmatter,
        };

        if (result.confidence >= 0.4 && result.kind !== 'plain') {
          confident.push(cn);
        } else {
          ambiguous.push(cn);
        }
      } catch (err) {
        if (signal.aborted) return;
        console.warn('[orchestrate.entities] classify failed for', note.sourcePath, err);
        // Keep as plain so nothing is lost.
        const displayName = note.basename.replace(/\.md$/i, '');
        confident.push({
          sourcePath: note.sourcePath,
          kind: 'plain',
          role: null,
          displayName,
          canonicalPath: note.sourcePath,
          confidence: 0,
          sheet: {},
          tags: [],
          wikilinks: [],
          portrait: null,
          body,
          existingFrontmatter: note.existingFrontmatter,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => classifyWorker()));
  if (signal.aborted) return;

  // Batch all ambiguous notes into a single DM question.
  if (ambiguous.length > 0) {
    const cap = 12; // keep the question readable
    const listed = ambiguous.slice(0, cap);
    const listText = listed
      .map((n, i) => {
        const excerpt = n.body.slice(0, 80).replace(/\n/g, ' ').trim();
        return `${i + 1}. **${n.displayName}** (${n.sourcePath})\n   My best guess: ${n.kind} (${Math.round(n.confidence * 100)}% confident)\n   "${excerpt}…"`;
      })
      .join('\n\n');

    const extra = ambiguous.length > cap ? `\n\n_(${ambiguous.length - cap} more notes will default to **lore**.)_` : '';

    const reply = await askDmChat(
      jobId,
      rawPlan,
      orch,
      `I'm not sure how to classify ${ambiguous.length} note${ambiguous.length !== 1 ? 's' : ''}. Can you help?\n\n` +
      `${listText}${extra}\n\n` +
      `For each number, reply with its kind: **character**, **person**, **creature**, **location**, **item**, **session**, **lore**, or **skip**.\n` +
      `Example: \`1. location  2. character  3. skip\``,
      signal,
    );
    if (signal.aborted) return;

    // Parse the DM's response — simple keyword scan per note.
    for (let i = 0; i < listed.length; i++) {
      const n = listed[i]!;
      const line = extractLineForNote(reply, i + 1, n.displayName);
      const lower = line.toLowerCase();

      if (/\bskip\b|\bignore\b/.test(lower)) continue;

      let kind = 'lore';
      let role: string | null = null;
      if (/\bcharacter\b|\bpc\b/.test(lower)) { kind = 'character'; role = 'pc'; }
      else if (/\bperson\b|\bnpc\b|\bally\b/.test(lower)) { kind = 'character'; role = /\bally\b/.test(lower) ? 'ally' : 'npc'; }
      else if (/\bvillain\b/.test(lower)) { kind = 'character'; role = 'villain'; }
      else if (/\bcreature\b|\bmonster\b/.test(lower)) { kind = 'creature'; }
      else if (/\blocation\b|\bplace\b/.test(lower)) { kind = 'location'; }
      else if (/\bitem\b|\bloot\b|\bweapon\b|\barmou?r\b/.test(lower)) { kind = 'item'; }
      else if (/\bsession\b|\blog\b/.test(lower)) { kind = 'session'; }
      else if (/\blore\b|\bworld\b/.test(lower)) { kind = 'lore'; }

      n.kind = kind;
      n.role = role;
      confident.push(n);
    }

    // Any past the cap default to lore.
    for (let i = cap; i < ambiguous.length; i++) {
      const n = ambiguous[i]!;
      n.kind = 'lore';
      confident.push(n);
    }
  }

  // Write all entities to the DB.
  const db = getDb();
  for (const cn of confident) {
    if (signal.aborted) return;

    // Compute the target path.
    let targetPath: string;
    if (cn.kind === 'plain' || cn.confidence === 0) {
      targetPath = cn.sourcePath;
    } else if (cn.confidence >= 0.4 && cn.canonicalPath.trim()) {
      targetPath = cn.canonicalPath.trim().replace(/^\/+|\/+$/g, '');
    } else {
      targetPath = fallbackPath(cn.displayName, cn.kind, cn.role, orch);
    }

    // Build frontmatter.
    const fm = buildEntityFrontmatter(cn, orch);
    const rewrittenBody = rewriteWikilinks(cn.body, cn.wikilinks);
    const markdown = composeMarkdown(fm, rewrittenBody);

    const existing = db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(job.groupId, targetPath);

    try {
      writeNote({
        groupId: job.groupId,
        userId: job.createdBy,
        path: targetPath,
        markdown,
        frontmatter: fm,
        isUpdate: !!existing,
        noteId: existing?.id,
      });
      orch.entityMap[cn.sourcePath] = targetPath;
    } catch (err) {
      console.warn('[orchestrate.entities] failed to write', targetPath, err);
    }
  }
}

// ── Phase 3: Quality ───────────────────────────────────────────────────

function runQualityPhase(job: ImportJob, orch: OrchestrationState): void {
  const db = getDb();
  let indexErrors = 0;

  for (const createdPath of Object.values(orch.entityMap)) {
    const row = db
      .query<{ frontmatter_json: string }, [string, string]>(
        'SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(job.groupId, createdPath);
    if (!row) continue;

    try {
      deriveAllIndexes({
        groupId: job.groupId,
        notePath: createdPath,
        frontmatterJson: row.frontmatter_json,
      });
    } catch {
      indexErrors++;
    }
  }

  const totalNotes = Object.keys(orch.entityMap).length;
  const totalAssets = Object.keys(orch.assetMap).length;
  orch.summary =
    `Imported ${totalNotes} note${totalNotes !== 1 ? 's' : ''} · ` +
    `${totalAssets} asset${totalAssets !== 1 ? 's' : ''} committed` +
    (indexErrors > 0 ? ` · ${indexErrors} index errors (notes still visible)` : '');
}

// ── Chat Q&A ───────────────────────────────────────────────────────────

async function askDmChat(
  jobId: string,
  rawPlan: ImportPlan,
  orch: OrchestrationState,
  message: string,
  signal: AbortSignal,
): Promise<string> {
  orch.conversationHistory.push({ role: 'assistant', content: message, timestamp: Date.now() });
  updateImportJob(jobId, {
    status: 'waiting_for_answer',
    plan: { ...rawPlan, orchestration: orch },
  });

  return new Promise<string>((resolve, reject) => {
    pendingAnswers.set(jobId, resolve);
    signal.addEventListener(
      'abort',
      () => {
        pendingAnswers.delete(jobId);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildClassifyContext(
  job: ImportJob,
  rawPlan: ImportPlan,
  orch: OrchestrationState,
): ImportSkillContext {
  const db = getDb();
  const existingPaths = db
    .query<{ path: string }, [string]>('SELECT path FROM notes WHERE group_id = ?')
    .all(job.groupId)
    .map((r) => r.path);
  const existingTags = db
    .query<{ tag: string }, [string]>(
      'SELECT DISTINCT tag FROM tags WHERE group_id = ? ORDER BY tag LIMIT 200',
    )
    .all(job.groupId)
    .map((r) => r.tag);

  const conventions = defaultConventions(orch.campaignSlug);
  if (orch.campaignSlug && orch.campaignRoot) {
    const root = orch.campaignRoot;
    conventions.campaignRoot = root;
    conventions.charactersFolder = `${root}/Characters`;
    conventions.peopleFolder = `${root}/People`;
    conventions.enemiesFolder = `${root}/Enemies`;
    conventions.adventureLogFolder = `${root}/Adventure Log`;
    conventions.placesFolder = `${root}/Places`;
    conventions.lootFolder = `${root}/Loot`;
    conventions.creaturesFolder = `${root}/Creatures`;
  }

  return {
    targetCampaignSlug: orch.campaignSlug,
    knownNotePaths: [...existingPaths, ...rawPlan.notes.map((n) => n.sourcePath)].slice(0, 400),
    knownImageBasenames: rawPlan.assets.map((a) => a.basename),
    existingVaultTags: existingTags,
    conventions,
  };
}

function buildEntityFrontmatter(
  cn: {
    kind: string;
    role: string | null;
    sheet: Record<string, unknown>;
    tags: string[];
    portrait: string | null;
    displayName: string;
    existingFrontmatter: Record<string, unknown>;
  },
  _orch: OrchestrationState,
): Record<string, unknown> {
  const fm: Record<string, unknown> = {};

  if (cn.kind === 'character') {
    fm.kind = 'character';
    if (cn.role) { fm.role = cn.role; fm.template = cn.role; }
  } else if (cn.kind !== 'plain') {
    fm.kind = cn.kind;
    fm.template = cn.kind;
  }

  // Sheet — merge AI-extracted fields; displayName always seeds the name.
  const sheet: Record<string, unknown> = { ...cn.sheet };
  if (cn.displayName && !sheet.name) sheet.name = cn.displayName;
  if (cn.portrait) sheet.portrait = cn.portrait;
  // Legacy flat mirrors for characters (CharacterSheet side panel reads them).
  if (cn.kind === 'character') {
    const hp = sheet.hit_points as { current?: number; max?: number } | undefined;
    if (hp?.current != null) sheet.hp_current = hp.current;
    if (hp?.max != null) sheet.hp_max = hp.max;
    const ac = sheet.armor_class as { value?: number } | undefined;
    if (ac?.value != null) sheet.ac = ac.value;
    const ab = sheet.ability_scores as Record<string, number> | undefined;
    if (ab) {
      for (const stat of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
        if (ab[stat] != null) sheet[stat] = ab[stat];
      }
    }
  }
  if (Object.keys(sheet).length > 0) fm.sheet = sheet;

  // Tags — union of existing + AI suggestions, capped at 12.
  const existingTags = readTagList(cn.existingFrontmatter.tags);
  const merged = [...new Set([...existingTags, ...cn.tags.map((t) => t.toLowerCase())])];
  if (merged.length > 0) fm.tags = merged.slice(0, 12);

  return fm;
}

function fallbackPath(
  name: string,
  kind: string,
  role: string | null,
  orch: OrchestrationState,
): string {
  let fk: EntityKind;
  if (kind === 'character') {
    if (role === 'npc') fk = 'npc';
    else if (role === 'ally') fk = 'ally';
    else if (role === 'villain') fk = 'villain';
    else fk = 'character';
  } else {
    fk = kind as EntityKind;
  }
  return canonicalPath({
    kind: fk,
    campaignSlug: orch.campaignSlug ?? undefined,
    campaignRoot: orch.campaignRoot ?? undefined,
    name,
  });
}

function pickExtractor(
  result: { kind: string; role: string | null },
): ((input: ExtractInput, opts: { signal?: AbortSignal }) => Promise<{
  result: { sheet: Record<string, unknown> };
  usage: unknown;
  costUsd: number;
}>) | null {
  if (result.kind === 'character') {
    switch (result.role) {
      case 'pc':      return extractPc;
      case 'ally':    return extractAlly;
      case 'villain': return extractVillain;
      default:        return extractNpc;
    }
  }
  switch (result.kind) {
    case 'location': return extractLocation;
    case 'item':     return extractItem;
    case 'session':  return extractSession;
    default:         return null;
  }
}

function splitBody(raw: string): string {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return raw;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return raw;
  return raw.slice(end + 4).replace(/^\s+/, '');
}

function rewriteWikilinks(
  body: string,
  links: Array<{ anchorText: string; target: string }>,
): string {
  let out = body;
  for (const link of links) {
    const anchor = link.anchorText?.trim();
    const target = link.target?.trim().replace(/\.md$/i, '');
    if (!anchor || !target) continue;
    const idx = out.indexOf(anchor);
    if (idx === -1) continue;
    const before = idx >= 2 ? out.slice(idx - 2, idx) : '';
    const after = out.slice(idx + anchor.length, idx + anchor.length + 2);
    if (before === '[[' || after === ']]') continue;
    out = out.slice(0, idx) + `[[${target}|${anchor}]]` + out.slice(idx + anchor.length);
  }
  return out;
}

function pickCampaignSlugFromPaths(paths: string[]): string | null {
  for (const p of paths) {
    const m = /^(?:[^/]+\/)?Campaigns\/([^/]+)\//i.exec(p);
    if (m) return slugify(m[1]!);
  }
  return null;
}

function extractLineForNote(reply: string, num: number, displayName: string): string {
  const lines = reply.split(/[\n,]+/);
  return (
    lines.find((l) => {
      const n = l.toLowerCase();
      return n.startsWith(`${num}.`) || n.startsWith(`${num} `) || n.includes(displayName.toLowerCase());
    }) ?? lines[num - 1] ?? ''
  );
}

function slugify(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function readTagList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean).map((t) => t.toLowerCase());
  return [];
}
