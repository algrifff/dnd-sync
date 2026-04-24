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
import { generateStructured } from './ai/openai';
import { runRelink, type EntityIndexEntry } from './ai/skills/relink';
import { canonicalPath, type EntityKind } from './ai/paths';
import { listCampaigns, ensureCampaignForPath } from './characters';
import { ensureIndexNote } from './index-notes';
import { deriveAllIndexes } from './derive-indexes';

// Canonical subfolders created for every new campaign — mirrors CampaignCreateDialog.
const CAMPAIGN_SUBFOLDERS = [
  'Characters', 'People', 'Enemies', 'Loot', 'Adventure Log', 'Places', 'Creatures', 'Quests',
] as const;

// ── Types ──────────────────────────────────────────────────────────────

/** One campaign resolved during the campaign phase. */
export type CampaignAssignment = {
  name: string;
  slug: string;
  /** e.g. "Campaigns/dragon-heist". Null means World Lore (no campaign). */
  root: string | null;
  /** Top-level folder from the source ZIP that maps to this campaign.
   *  Empty string = catch-all (used when all notes share one campaign). */
  sourcePrefix: string;
};

export type OrchestrationState = {
  phase: 'assets' | 'campaign' | 'entities' | 'quality' | 'done';
  /** basename.toLowerCase() → vault path written to DB */
  assetMap: Record<string, string>;
  /** sourcePath → final note path in DB */
  entityMap: Record<string, string>;
  /** Populated once by runCampaignPhase. Null = not yet answered.
   *  Empty array = user chose no campaigns (World Lore only). */
  campaignAssignments: CampaignAssignment[] | null;
  conversationHistory: Array<{
    role: 'assistant' | 'user';
    content: string;
    timestamp: number;
  }>;
  summary: string | null;
  phaseLog: Array<{ phase: string; completedAt: number; count?: number }>;
  /** Latest action — overwritten (not appended) so the UI can cycle it. */
  currentActivity: string | null;
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
  const resumable =
    job.status === 'uploaded' ||
    job.status === 'ready' ||
    job.status === 'waiting_for_answer' ||
    job.status === 'orchestrating_assets' ||
    job.status === 'orchestrating_campaign' ||
    job.status === 'orchestrating_entities' ||
    job.status === 'orchestrating_quality';
  if (!resumable) return;

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
  const orch: OrchestrationState = plan.orchestration
    ? migrateOrch(plan.orchestration)
    : {
        phase: 'assets',
        assetMap: {},
        entityMap: {},
        campaignAssignments: null,
        conversationHistory: [],
        summary: null,
        phaseLog: [],
        currentActivity: null,
      };

  const setActivity = (msg: string): void => {
    orch.currentActivity = msg;
    updateImportJob(jobId, { plan: { ...rawPlan, orchestration: orch } });
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
    runAssetsPhase(job, orch, rawPlan, entryByPath, setActivity);
    orch.phaseLog.push({ phase: 'assets', completedAt: Date.now(), count: Object.keys(orch.assetMap).length });
    orch.phase = 'campaign';
    saveState('orchestrating_campaign');
  }

  if (signal.aborted) return;

  // Phase 1 — Campaign
  if (orch.phase === 'campaign') {
    await runCampaignPhase(jobId, job, orch, rawPlan, signal, setActivity);
    if (signal.aborted) return;
    orch.phaseLog.push({ phase: 'campaign', completedAt: Date.now() });
    orch.phase = 'entities';
    saveState('orchestrating_entities');
  }

  // Ensure World Lore folder marker + index page exist before entities are
  // written so lore notes have a visible home and a "folder-as-page" target.
  ensureWorldLoreIndex(job);

  // Phase 2 — Entities
  if (orch.phase === 'entities') {
    await runEntitiesPhase(jobId, job, orch, rawPlan, entryByPath, signal, setActivity);
    if (signal.aborted) return;
    orch.phaseLog.push({ phase: 'entities', completedAt: Date.now(), count: Object.keys(orch.entityMap).length });
    orch.phase = 'quality';
    saveState('orchestrating_quality');
  }

  // Phase 3 — Quality
  if (orch.phase === 'quality') {
    await runQualityPhase(job, orch, signal, setActivity);
    if (signal.aborted) return;
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
  setActivity: (msg: string) => void,
): void {
  for (const asset of rawPlan.assets) {
    const entry = entryByPath.get(asset.sourcePath);
    if (!entry) continue;
    const folder = asset.mime?.startsWith('image/') ? 'Assets/Portraits' : 'Assets';
    const vaultPath = `${folder}/${asset.basename}`;
    setActivity(`Saving ${asset.basename}`);
    try {
      commitAsset(job, entry.getData(), vaultPath);
      orch.assetMap[asset.basename.toLowerCase()] = vaultPath;
    } catch (err) {
      console.warn('[orchestrate.assets] failed to commit', asset.basename, err);
    }
  }
}

// ── Phase 1: Campaign ──────────────────────────────────────────────────
//
// AI reads the folder/file names in the ZIP, proposes which top-level
// folders are campaigns vs world lore, and asks the DM to confirm.
// One simple "yes" / correction reply — no raw path listing.

async function runCampaignPhase(
  jobId: string,
  job: ImportJob,
  orch: OrchestrationState,
  rawPlan: ImportPlan,
  signal: AbortSignal,
  setActivity: (msg: string) => void,
): Promise<void> {
  if (orch.campaignAssignments !== null) return;

  setActivity('Analysing vault structure…');

  const existing = listCampaigns(job.groupId);

  // AI determines the campaign groupings from folder/file names.
  const proposal = await aiAnalyseStructure(rawPlan.notes, existing, signal);
  if (signal.aborted) return;

  // Build a human-readable confirmation message.
  const proposalLines = proposal.map((g, i) => {
    const count = rawPlan.notes.filter((n) =>
      g.sourceFolder === ''
        ? !n.sourcePath.includes('/')
        : n.sourcePath === g.sourceFolder ||
          n.sourcePath.startsWith(g.sourceFolder + '/'),
    ).length;
    return g.isWorldLore
      ? `${i + 1}. **${g.sourceFolder || '(root notes)'}** → World Lore (${count} notes)`
      : `${i + 1}. **${g.sourceFolder || '(root notes)'}** → Campaign: **"${g.suggestedName}"** (${count} notes)`;
  });

  const questionText =
    `I've analysed your vault and here's what I found:\n\n` +
    `${proposalLines.join('\n')}\n\n` +
    `Reply **"yes"** to proceed, or correct any entry by number.\n` +
    `_(e.g. "1: Dragon Heist, 3: World Lore")_`;

  const reply = await askDmChat(jobId, rawPlan, orch, questionText, signal);
  if (signal.aborted) return;

  const assignments: CampaignAssignment[] = [];
  const isConfirm = /^\s*(yes|yeah|correct|looks?\s+good|ok|okay|yep|sure|proceed|go|✓|👍)\s*$/i.test(reply.trim());

  if (isConfirm) {
    // Accept the AI proposal as-is.
    for (const g of proposal) {
      const prefix = g.sourceFolder;
      if (g.isWorldLore) {
        assignments.push({ name: '', slug: '', root: null, sourcePrefix: prefix });
      } else {
        const a = resolveOrCreateCampaign(job, existing, g.suggestedName, prefix, setActivity);
        assignments.push(a);
        if (!existing.find((c) => c.slug === a.slug))
          existing.push({ slug: a.slug, name: a.name, folderPath: a.root ?? '' });
      }
    }
  } else {
    // DM provided corrections — parse "N: Name" tokens, fallback to proposal for uncorrected groups.
    const corrections = new Map<number, string>();
    for (const m of reply.matchAll(/(\d+)\s*[:=]\s*([^,\n]+)/g)) {
      corrections.set(Number(m[1]), m[2]!.trim().replace(/^["']|["']$/g, ''));
    }

    for (let i = 0; i < proposal.length; i++) {
      const g = proposal[i]!;
      const prefix = g.sourceFolder;
      const correctedName = corrections.get(i + 1);

      if (correctedName !== undefined) {
        if (/^(none|world\s+lore|lore)$/i.test(correctedName)) {
          assignments.push({ name: '', slug: '', root: null, sourcePrefix: prefix });
        } else {
          const a = resolveOrCreateCampaign(job, existing, correctedName, prefix, setActivity);
          assignments.push(a);
          if (!existing.find((c) => c.slug === a.slug))
            existing.push({ slug: a.slug, name: a.name, folderPath: a.root ?? '' });
        }
      } else {
        // Unchanged — use AI proposal.
        if (g.isWorldLore) {
          assignments.push({ name: '', slug: '', root: null, sourcePrefix: prefix });
        } else {
          const a = resolveOrCreateCampaign(job, existing, g.suggestedName, prefix, setActivity);
          assignments.push(a);
          if (!existing.find((c) => c.slug === a.slug))
            existing.push({ slug: a.slug, name: a.name, folderPath: a.root ?? '' });
        }
      }
    }
  }

  orch.campaignAssignments = assignments;
}

// ── AI structure analysis ──────────────────────────────────────────────
//
// Analyses folder and file names in the ZIP to identify campaigns vs
// world lore. No file content is read — just names and counts.

type StructureGroup = {
  sourceFolder: string;
  suggestedName: string;
  isWorldLore: boolean;
};

async function aiAnalyseStructure(
  notes: ImportPlan['notes'],
  existing: Array<{ slug: string; name: string }>,
  signal: AbortSignal,
): Promise<StructureGroup[]> {
  // Render a proper directory tree (up to 3 levels deep) with per-folder
  // counts + sample file names. The AI needs to see nested structure
  // because Obsidian / Drive exports usually wrap everything in a
  // single top-level folder (vault name), and the real campaign
  // divisions live one or two levels deeper.
  const tree = renderDirectoryTree(notes, 3);

  const existingHint =
    existing.length > 0
      ? `\nExisting campaigns in this world: ${existing.map((c) => c.name).join(', ')}.`
      : '';

  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sourceFolder: {
              type: 'string',
              description:
                'Exact path prefix relative to the ZIP root — include wrapper folders. Empty string = root-level notes.',
            },
            suggestedName: { type: 'string' },
            isWorldLore: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['sourceFolder', 'suggestedName', 'isWorldLore', 'reason'],
        },
      },
    },
    required: ['groups'],
  };

  const systemPrompt = [
    'You are analysing a TTRPG vault import to plan how notes should be organised into campaigns.',
    '',
    'GOAL: output one entry in `groups` per distinct campaign or world-lore bucket you detect.',
    '',
    'Interpreting the tree:',
    '  • The ZIP often has a WRAPPER folder (the vault name, e.g. "My Vault - Export", "The-Compendium"',
    '    "MyCampaign_backup_2024"). Do NOT treat the wrapper as a campaign. Look INSIDE it.',
    '  • A folder literally named "Campaigns" (or "Games", "Adventures") that contains sub-folders is',
    '    a META-folder. Each sub-folder inside it is a separate campaign.',
    '  • A folder named "World", "World Lore", "Lore", "Worldbuilding", "Shared", "Global", "Setting"',
    '    is world lore — notes not tied to a single campaign.',
    '  • A folder named "One-Shots", "Oneshots", "Short Games" is typically world lore or a side',
    '    campaign — call it campaign "One-Shots" unless the user hints otherwise.',
    '  • Folders named "Characters", "NPCs", "People", "Party", "Sessions", "Adventure Log",',
    '    "Locations", "Places", "Items", "Loot", "Enemies", "Villains", "Creatures", "Monsters",',
    '    "Bestiary", "Houses", "Factions", "Maps", "Portraits" are CONTENT folders that live INSIDE',
    '    a campaign or world-lore bucket. They are NEVER a campaign themselves. If they appear at',
    '    the top level of an unwrapped vault, treat the whole vault as one unnamed campaign.',
    '',
    'Output format:',
    '  • sourceFolder: the EXACT path prefix relative to the ZIP root, including any wrapper',
    '    (e.g. "The-Compendium/Campaigns/Campaign 2", "My Vault/World", "MyVault").',
    '  • suggestedName: a clean human-readable name. Strip dates, "backup", "export", "v2",',
    '    underscores → spaces, title-case. For world-lore buckets, use "World Lore".',
    '  • isWorldLore: true if the folder is world-building / shared / not tied to one campaign.',
    '  • reason: one short sentence explaining your choice (for debugging).',
    '',
    'Coverage rule: every note in the tree must be reachable via exactly one group\'s sourceFolder',
    '(by path prefix). Groups must not overlap, and together they must cover everything.',
    existingHint,
  ].join('\n');

  const userContent = `Total notes: ${notes.length}\n\nDirectory tree:\n${tree}`;

  type Raw = { groups: Array<StructureGroup & { reason?: string }> };
  try {
    const out = await generateStructured<Raw>({
      systemPrompt,
      userContent,
      schema,
      schemaName: 'vault_structure',
      signal,
    });
    if (out.data.groups.length > 0) {
      return out.data.groups.map((g) => ({
        sourceFolder: g.sourceFolder,
        suggestedName: g.suggestedName,
        isWorldLore: g.isWorldLore,
      }));
    }
  } catch (err) {
    console.warn('[orchestrate.campaign] aiAnalyseStructure failed, falling back:', err);
  }

  // Fallback: strip common wrapper, then treat each resulting top-level folder as a group.
  return heuristicGroups(notes);
}

/** Build a readable directory tree from parsed notes, limited to `maxDepth`
 *  levels. Each folder shows its cumulative note count and up to 4 sample
 *  file names so the AI can see what the folder contains. */
function renderDirectoryTree(
  notes: Array<{ sourcePath: string; basename: string }>,
  maxDepth: number,
): string {
  type Node = { files: string[]; children: Map<string, Node> };
  const root: Node = { files: [], children: new Map() };

  for (const note of notes) {
    const parts = note.sourcePath.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let child = cur.children.get(seg);
      if (!child) {
        child = { files: [], children: new Map() };
        cur.children.set(seg, child);
      }
      cur = child;
    }
    cur.files.push(note.basename.replace(/\.md$/i, ''));
  }

  function total(n: Node): number {
    let c = n.files.length;
    for (const ch of n.children.values()) c += total(ch);
    return c;
  }

  const lines: string[] = [];
  function walk(node: Node, indent: string, depth: number, pathSoFar: string): void {
    // Show the files directly in this folder (if any and depth allows).
    if (node.files.length > 0 && depth > 0) {
      const sample = node.files.slice(0, 4).join(', ');
      const more = node.files.length > 4 ? `, … +${node.files.length - 4} more` : '';
      lines.push(`${indent}[files here: ${sample}${more}]`);
    }

    const sortedChildren = [...node.children.entries()].sort(
      (a, b) => total(b[1]) - total(a[1]),
    );

    for (const [name, child] of sortedChildren) {
      const childPath = pathSoFar ? `${pathSoFar}/${name}` : name;
      const count = total(child);
      const directFiles = child.files.length;
      const summary = directFiles > 0 && child.children.size === 0
        ? ` — ${count} files (${child.files.slice(0, 4).join(', ')}${child.files.length > 4 ? ', …' : ''})`
        : ` — ${count} notes total`;
      lines.push(`${indent}${name}/${summary}`);
      if (depth + 1 < maxDepth) {
        walk(child, indent + '  ', depth + 1, childPath);
      } else if (child.children.size > 0) {
        const subs = [...child.children.keys()].slice(0, 6).join(', ');
        lines.push(`${indent}  [sub-folders: ${subs}${child.children.size > 6 ? ', …' : ''}]`);
      }
    }
  }

  if (root.files.length > 0) {
    const sample = root.files.slice(0, 4).join(', ');
    lines.push(`(root-level files) — ${root.files.length} notes (${sample})`);
  }
  walk(root, '', 0, '');
  return lines.join('\n');
}

/** Heuristic fallback when the AI call fails. Detects a common wrapper
 *  folder, strips it, then treats each resulting top-level entry as a
 *  campaign (or world lore for obviously world-named folders). */
function heuristicGroups(notes: ImportPlan['notes']): StructureGroup[] {
  const wrapper = detectCommonWrapper(notes);
  const groups = new Map<string, string[]>();

  for (const note of notes) {
    const rel = wrapper ? note.sourcePath.slice(wrapper.length + 1) : note.sourcePath;
    const slash = rel.indexOf('/');
    const top = slash >= 0 ? rel.slice(0, slash) : '';
    const absoluteFolder = wrapper ? (top ? `${wrapper}/${top}` : wrapper) : top;
    const list = groups.get(absoluteFolder) ?? [];
    list.push(note.basename);
    groups.set(absoluteFolder, list);
  }

  return [...groups.keys()].map((folder) => {
    const leaf = folder.split('/').pop() ?? '';
    const isWorldLore = /^(world\s*lore|lore|world|worldbuilding|shared|global|setting)$/i.test(leaf);
    return {
      sourceFolder: folder,
      suggestedName: isWorldLore ? 'World Lore' : cleanFolderName(leaf || 'My Campaign'),
      isWorldLore,
    };
  });
}

/** Return the longest common folder prefix shared by all notes, or null
 *  if there is none. Used to detect export wrappers like "MyVault/". */
function detectCommonWrapper(notes: Array<{ sourcePath: string }>): string | null {
  if (notes.length === 0) return null;
  const firstParts = notes[0]!.sourcePath.split('/');
  if (firstParts.length < 2) return null; // at root already

  let depth = firstParts.length - 1; // never include the file itself
  for (const note of notes) {
    const parts = note.sourcePath.split('/');
    let i = 0;
    while (i < depth && i < parts.length - 1 && parts[i] === firstParts[i]) i++;
    depth = i;
    if (depth === 0) return null;
  }
  return firstParts.slice(0, depth).join('/');
}

/** Create the hidden World Lore/index.md page (the "folder-as-page" target
 *  for the sidebar). Idempotent — no-op if the note already exists. */
function ensureWorldLoreIndex(job: ImportJob): void {
  const db = getDb();
  const now = Date.now();
  db.query(
    `INSERT OR IGNORE INTO folder_markers (group_id, path, created_at) VALUES (?, ?, ?)`,
  ).run(job.groupId, 'World Lore', now);

  const existing = db
    .query<{ id: string }, [string, string]>(
      'SELECT id FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(job.groupId, 'World Lore/index.md');
  if (existing) return;

  const fm = { kind: 'note', title: 'World Lore' };
  writeNote({
    groupId: job.groupId,
    userId: job.createdBy,
    path: 'World Lore/index.md',
    markdown: composeMarkdown(
      fm,
      '# World Lore\n\nShared worldbuilding, factions, cosmology, and lore that lives outside any single campaign.\n',
    ),
    frontmatter: fm,
    isUpdate: false,
  });
}

/** Insert folder markers for a campaign root + every canonical subfolder.
 *  Idempotent (INSERT OR IGNORE). Safe to call for matched OR newly created
 *  campaigns — guarantees sidebar shows every subfolder even if empty. */
function ensureCampaignSubfolders(groupId: string, slug: string): void {
  const db = getDb();
  const campaignPath = `Campaigns/${slug}`;
  const now = Date.now();
  db.query(
    `INSERT OR IGNORE INTO folder_markers (group_id, path, created_at) VALUES (?, ?, ?)`,
  ).run(groupId, campaignPath, now);
  for (const sf of CAMPAIGN_SUBFOLDERS) {
    db.query(
      `INSERT OR IGNORE INTO folder_markers (group_id, path, created_at) VALUES (?, ?, ?)`,
    ).run(groupId, `${campaignPath}/${sf}`, now);
  }
}

/** True if the parsed note's name looks like a campaign-level summary /
 *  overview page — the kind of content that belongs on the campaign's
 *  folder-as-page `index.md`, not as a separate entity. */
function isCampaignSummaryNote(displayName: string, assignment: CampaignAssignment): boolean {
  const d = displayName.trim();
  if (!d) return false;
  const campaignName = assignment.name.trim();

  // "Campaign 1 - Foo", "Campaign 2: Bar", "Campaign 3 — Baz"
  if (/^campaign\s*\d+\s*[-–—:]\s*.+/i.test(d)) return true;
  // "Campaign Overview", "Campaign Summary", "Overview", "Summary"
  if (/^(campaign\s+)?(overview|summary|index|readme|home|main)$/i.test(d)) return true;
  // Matches the campaign's own name (e.g. note named "Lost Mine of Phandelver"
  // inside a campaign with slug `lost-mine-of-phandelver`).
  if (campaignName && d.toLowerCase() === campaignName.toLowerCase()) return true;
  if (campaignName && d.toLowerCase() === `${campaignName.toLowerCase()} overview`) return true;
  if (campaignName && d.toLowerCase() === `${campaignName.toLowerCase()} summary`) return true;

  return false;
}

/** Append/merge summary-note content into a campaign's `index.md` body.
 *  The index note is created by `createCampaignSkeleton` with a minimal
 *  `# Name\n` stub — we replace the stub on first merge, and append on
 *  subsequent merges so multiple summary notes can coexist. */
function mergeIntoIndexNote(
  job: ImportJob,
  indexPath: string,
  campaignName: string,
  body: string,
): void {
  const db = getDb();
  const existing = db
    .query<{ id: string; content_md: string | null; frontmatter_json: string }, [string, string]>(
      'SELECT id, content_md, frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(job.groupId, indexPath);

  const trimmedIncoming = body.trim();
  if (!trimmedIncoming) return;

  let fm: Record<string, unknown> = { kind: 'note', title: campaignName };
  let currentBody = '';
  if (existing) {
    try {
      const parsed = JSON.parse(existing.frontmatter_json) as Record<string, unknown>;
      fm = { ...parsed, kind: parsed.kind ?? 'note', title: parsed.title ?? campaignName };
    } catch {
      // keep default fm
    }
    // Strip frontmatter from content_md — composeMarkdown re-adds it.
    const md = existing.content_md ?? '';
    currentBody = stripFrontmatter(md).trim();
  }

  // First merge replaces the "# Name" stub; subsequent merges append.
  const stubRe = new RegExp(`^#\\s+${escapeRegex(campaignName)}\\s*$`, 'i');
  const isStub = !currentBody || stubRe.test(currentBody);

  const nextBody = isStub
    ? trimmedIncoming
    : `${currentBody}\n\n---\n\n${trimmedIncoming}`;

  writeNote({
    groupId: job.groupId,
    userId: job.createdBy,
    path: indexPath,
    markdown: composeMarkdown(fm, nextBody),
    frontmatter: fm,
    isUpdate: !!existing,
    noteId: existing?.id,
  });
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\s*\n/, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createCampaignSkeleton(job: ImportJob, name: string, slug: string): void {
  const campaignPath = `Campaigns/${slug}`;

  // Folder markers — mirrors what CampaignCreateDialog does in the UI so
  // the sidebar tree shows all subfolders immediately, even before any
  // entities land in them.
  ensureCampaignSubfolders(job.groupId, slug);

  // Register the campaign row so dashboards can list it immediately.
  ensureCampaignForPath(job.groupId, `${campaignPath}/index.md`);

  // Campaign root note — the campaign auto-registers via deriveAllIndexes
  // when this note is written.
  const fm = { kind: 'note', title: name };
  writeNote({
    groupId: job.groupId,
    userId: job.createdBy,
    path: `${campaignPath}/index.md`,
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
  setActivity: (msg: string) => void,
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
        setActivity(`Classifying ${note.basename}…`);
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
        if (extractor) setActivity(`Extracting sheet for ${result.displayName}…`);
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

  // Ambiguous notes auto-classify as lore — no Q&A. The DM can manually
  // move them after the import. Asking per-batch questions here is a
  // second blocking point that causes the import to feel stuck.
  for (const n of ambiguous) {
    n.kind = 'lore';
    confident.push(n);
  }

  // Write all entities to the DB.
  const db = getDb();
  // Track paths used in THIS import so we can deduplicate within the batch.
  const usedPaths = new Set<string>(
    Object.values(orch.entityMap), // paths from a resumed partial run
  );

  for (const cn of confident) {
    if (signal.aborted) return;

    // Find the campaign this note belongs to by matching its source prefix,
    // then derive the canonical path from kind + displayName.
    const assignment = findCampaignForNote(cn.sourcePath, orch.campaignAssignments ?? []);

    // Summary-note detection: a raw note named "Campaign N - Foo",
    // "Campaign Overview", or matching the campaign's own name is the
    // Notion-style folder-as-page content. Merge it into the campaign's
    // `index.md` body instead of creating a duplicate entity alongside it.
    if (assignment && isCampaignSummaryNote(cn.displayName, assignment)) {
      const indexPath = `${assignment.root ?? `Campaigns/${assignment.slug}`}/index.md`;
      try {
        setActivity(`Merging "${cn.displayName}" into ${assignment.name} index…`);
        mergeIntoIndexNote(job, indexPath, assignment.name, cn.body);
        orch.entityMap[cn.sourcePath] = indexPath;
      } catch (err) {
        console.error('[orchestrate.entities] merge-into-index failed', indexPath, err);
      }
      continue;
    }

    const effectiveKind = cn.kind === 'plain' ? 'lore' : cn.kind;
    let targetPath = campaignPath(cn.displayName, effectiveKind, cn.role, assignment);

    // Deduplicate within this import batch (two notes can have the same
    // display name; append -2, -3, … to the slug to avoid overwriting).
    if (usedPaths.has(targetPath)) {
      const base = targetPath.replace(/\.md$/, '');
      let counter = 2;
      while (usedPaths.has(`${base}-${counter}.md`)) counter++;
      targetPath = `${base}-${counter}.md`;
    }
    usedPaths.add(targetPath);

    const fm = buildEntityFrontmatter(cn, orch);
    const rewrittenBody = rewriteWikilinks(cn.body, cn.wikilinks);
    const markdown = composeMarkdown(fm, rewrittenBody);

    const existing = db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(job.groupId, targetPath);

    try {
      setActivity(`Writing ${cn.displayName}…`);
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
      console.error('[orchestrate.entities] write failed', targetPath, err);
    }
  }
}

// ── Phase 3: Quality ───────────────────────────────────────────────────
//
// Dedicated AI link-rewriting pass. For every imported note the relink
// skill sees the full markdown body and the complete entity index
// (sourcePath → canonicalPath for every sibling in the drop) and returns
// structured find-and-replace instructions that rewrite Obsidian-style
// wikilinks like `[[Party/Ignys Silverspear]]` or
// `[[../Campaign 3/NPCs/Villains/Atoxis]]` into canonical vault paths.
//
// We apply the AI replacements as literal string substitutions (no prose
// is touched — the AI cannot hallucinate or delete content), then re-run
// writeNote with isUpdate=true so the md→pm ingest pipeline re-resolves
// wikilink nodes against the full vault and `note_links` rows land with
// the correct `to_path` values.

async function runQualityPhase(
  job: ImportJob,
  orch: OrchestrationState,
  signal: AbortSignal,
  setActivity: (msg: string) => void,
): Promise<void> {
  setActivity('Reviewing and re-linking every note…');
  const db = getDb();

  // Build the entity index once — every imported note's sourcePath →
  // canonicalPath plus displayName and kind, so the relink skill can
  // resolve bare basenames and cross-campaign refs.
  const entries = Object.entries(orch.entityMap);
  const index: EntityIndexEntry[] = entries.map(([sourcePath, createdPath]) => {
    const row = db
      .query<{ frontmatter_json: string }, [string, string]>(
        'SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(job.groupId, createdPath);
    let displayName = createdPath.split('/').pop()?.replace(/\.md$/i, '') ?? createdPath;
    let kind = 'note';
    if (row) {
      try {
        const fm = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
        const sheet = (fm.sheet as Record<string, unknown> | undefined) ?? {};
        if (typeof sheet.name === 'string' && sheet.name.trim()) displayName = sheet.name;
        else if (typeof fm.title === 'string' && fm.title.trim()) displayName = fm.title;
        if (typeof fm.kind === 'string') kind = fm.kind;
      } catch {
        /* ignore */
      }
    }
    return { sourcePath, canonicalPath: createdPath, displayName, kind };
  });

  // Tag-match map: slugified displayName / campaign name → hub note entry.
  // Used to turn a tag like "dragon-heist" or a location name tag into a
  // backlink to that entity's note. Campaign slugs + names point at the
  // campaign's index.md so the graph shows campaigns as hubs.
  const tagEntityMap = new Map<string, EntityIndexEntry>();
  for (const e of index) {
    const s = slugify(e.displayName);
    if (s && !tagEntityMap.has(s)) tagEntityMap.set(s, e);
  }
  for (const a of orch.campaignAssignments ?? []) {
    if (!a.slug || !a.root) continue;
    const hub: EntityIndexEntry = {
      sourcePath: '',
      canonicalPath: `${a.root}/index.md`,
      displayName: a.name,
      kind: 'campaign',
    };
    tagEntityMap.set(a.slug, hub);
    const nameSlug = slugify(a.name);
    if (nameSlug) tagEntityMap.set(nameSlug, hub);
  }
  // World Lore hub — match common aliases.
  const worldLoreHub: EntityIndexEntry = {
    sourcePath: '',
    canonicalPath: 'World Lore/index.md',
    displayName: 'World Lore',
    kind: 'world-lore',
  };
  for (const alias of ['world-lore', 'worldlore', 'lore', 'world']) {
    if (!tagEntityMap.has(alias)) tagEntityMap.set(alias, worldLoreHub);
  }

  type Plan = {
    createdPath: string;
    markdown: string;
    frontmatter: Record<string, unknown>;
    frontmatterJson: string;
    noteId: string;
    resolved: number;
    unresolved: number;
  };
  const plans = new Map<string, Plan>();

  // Relink is AI-heavy — run up to 4 in parallel.
  const concurrency = 4;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const i = cursor++;
      if (i >= entries.length) return;
      const [sourcePath, createdPath] = entries[i]!;

      const row = db
        .query<
          { id: string; content_md: string; frontmatter_json: string },
          [string, string]
        >(
          'SELECT id, content_md, frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
        )
        .get(job.groupId, createdPath);
      if (!row) continue;

      let frontmatter: Record<string, unknown> = {};
      try {
        frontmatter = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
      } catch {
        /* ignore */
      }

      const body = splitBody(row.content_md ?? '');
      const displayName =
        index.find((e) => e.canonicalPath === createdPath)?.displayName ??
        createdPath.split('/').pop()?.replace(/\.md$/i, '') ??
        createdPath;

      setActivity(`Relinking ${createdPath.split('/').pop()}…`);

      let newBody = body;
      let resolved = 0;
      let unresolved = 0;

      // Skip the AI round-trip for notes with no wikilinks at all.
      if (/\[\[[^\]]+\]\]/.test(body)) {
        try {
          const { result } = await runRelink(
            {
              sourcePath,
              canonicalPath: createdPath,
              displayName,
              content: body,
              entityIndex: index,
            },
            { signal },
          );
          for (const rep of result.replacements) {
            if (
              rep.resolved &&
              rep.replacement &&
              rep.replacement !== rep.original &&
              newBody.includes(rep.original)
            ) {
              newBody = newBody.split(rep.original).join(rep.replacement);
              resolved++;
            } else if (!rep.resolved) {
              unresolved++;
            }
          }
        } catch (err) {
          if (!signal.aborted) {
            console.warn('[orchestrate.quality] relink failed for', createdPath, err);
          }
        }
      }

      // Attach this entity to its campaign (or World Lore) hub, and to any
      // known entity referenced by a tag. These become real note_links
      // edges via the md→pm ingest pipeline, so the graph shows each
      // campaign / hub with incoming edges from its members.
      const assignment = findCampaignForNote(sourcePath, orch.campaignAssignments ?? []);
      newBody = enrichWithHubLinks(
        newBody,
        frontmatter,
        createdPath,
        assignment,
        tagEntityMap,
      );

      plans.set(createdPath, {
        createdPath,
        markdown: composeMarkdown(frontmatter, newBody),
        frontmatter,
        frontmatterJson: row.frontmatter_json,
        noteId: row.id,
        resolved,
        unresolved,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (signal.aborted) return;

  // Apply the rewrites sequentially so SQLite writes don't fight each
  // other, and so note_links for note A see note B already on disk.
  let aiResolved = 0;
  let unresolvedTotal = 0;
  let reingested = 0;
  let indexErrors = 0;

  for (const createdPath of Object.values(orch.entityMap)) {
    if (signal.aborted) return;
    const plan = plans.get(createdPath);
    if (!plan) continue;
    aiResolved += plan.resolved;
    unresolvedTotal += plan.unresolved;

    try {
      setActivity(`Finalising ${createdPath.split('/').pop()}…`);
      writeNote({
        groupId: job.groupId,
        userId: job.createdBy,
        path: plan.createdPath,
        markdown: plan.markdown,
        frontmatter: plan.frontmatter,
        isUpdate: true,
        noteId: plan.noteId,
      });
      reingested++;
    } catch (err) {
      console.warn('[orchestrate.quality] re-ingest failed for', createdPath, err);
    }

    try {
      deriveAllIndexes({
        groupId: job.groupId,
        notePath: plan.createdPath,
        frontmatterJson: plan.frontmatterJson,
      });
    } catch {
      indexErrors++;
    }
  }

  // Count non-orphan links so the summary reflects real cross-links.
  let totalLinks = 0;
  const paths = Object.values(orch.entityMap);
  if (paths.length > 0) {
    const placeholders = paths.map(() => '?').join(',');
    const linkRow = db
      .query<{ n: number }, string[]>(
        `SELECT COUNT(*) AS n FROM note_links
          WHERE group_id = ?
            AND from_path IN (${placeholders})
            AND to_path NOT LIKE '__orphan__:%'`,
      )
      .get(job.groupId, ...paths);
    totalLinks = linkRow?.n ?? 0;
  }

  const totalNotes = Object.keys(orch.entityMap).length;
  const totalAssets = Object.keys(orch.assetMap).length;
  orch.summary =
    `Imported ${totalNotes} note${totalNotes !== 1 ? 's' : ''} · ` +
    `${totalAssets} asset${totalAssets !== 1 ? 's' : ''} · ` +
    `${totalLinks} backlink${totalLinks !== 1 ? 's' : ''} resolved` +
    (aiResolved > 0 ? ` (${aiResolved} AI-rewritten)` : '') +
    (unresolvedTotal > 0 ? ` · ${unresolvedTotal} unresolved link${unresolvedTotal !== 1 ? 's' : ''}` : '') +
    (indexErrors > 0 ? ` · ${indexErrors} index errors` : '') +
    (reingested !== totalNotes ? ` · ${totalNotes - reingested} re-link failures` : '');
}

// ── Chat Q&A ───────────────────────────────────────────────────────────

async function askDmChat(
  jobId: string,
  rawPlan: ImportPlan,
  orch: OrchestrationState,
  message: string,
  signal: AbortSignal,
): Promise<string> {
  // Idempotent on worker restart. Three cases:
  //   1. Tail is a user reply that answers this exact question — the DM
  //      already answered before the worker came back. Return it
  //      immediately, do not re-ask.
  //   2. Tail is the same assistant question — don't duplicate the
  //      message; just wait for a reply.
  //   3. Otherwise this is a fresh ask — push it to history.
  const history = orch.conversationHistory;
  const last = history.at(-1);
  const prev = history.length >= 2 ? history[history.length - 2] : undefined;
  const resumedWithAnswer =
    last?.role === 'user' &&
    prev?.role === 'assistant' &&
    prev.content === message;
  if (resumedWithAnswer) {
    return last!.content;
  }

  const alreadyAsked = last?.role === 'assistant' && last.content === message;
  if (!alreadyAsked) {
    orch.conversationHistory.push({ role: 'assistant', content: message, timestamp: Date.now() });
  }
  updateImportJob(jobId, {
    status: 'waiting_for_answer',
    plan: { ...rawPlan, orchestration: orch },
  });

  const reply = await new Promise<string>((resolve, reject) => {
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

  // Pull the DM's reply (appended to DB by the /answer route) back into
  // our in-memory orch so future saveState calls don't overwrite it.
  const fresh = getImportJob(jobId)?.plan as PlanWithOrch | undefined;
  if (fresh?.orchestration) {
    orch.conversationHistory = fresh.orchestration.conversationHistory;
  }

  return reply;
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

  const primaryAssignment = orch.campaignAssignments?.[0] ?? null;
  const conventions = defaultConventions(primaryAssignment?.slug ?? null);
  if (primaryAssignment?.root) {
    const root = primaryAssignment.root;
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
    targetCampaignSlug: primaryAssignment?.slug ?? null,
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

/** Derive the canonical DB path for an entity given its campaign assignment.
 *
 *  IMPORTANT: top-level `Characters/`, `People/`, `Places/`, etc. folders
 *  are strictly reserved for the "no-campaign" pathway in `paths.ts` — we
 *  never want an import to drop anything at that level because it creates
 *  stray folders next to `Campaigns/` and `World Lore/`. When the note
 *  belongs to a world-lore bucket (no campaign slug), force it under
 *  `World Lore/` regardless of its classified kind. */
function campaignPath(
  name: string,
  kind: string,
  role: string | null,
  assignment: CampaignAssignment | null,
): string {
  const hasCampaign = !!assignment?.slug;

  // World-lore bucket → flat under `World Lore/`. Preserve the note's kind
  // in frontmatter so headers/indexes still render correctly — only the
  // path is forced.
  if (!hasCampaign) {
    return canonicalPath({ kind: 'lore', name });
  }

  let fk: EntityKind;
  if (kind === 'character') {
    if (role === 'npc') fk = 'npc';
    else if (role === 'ally') fk = 'ally';
    else if (role === 'villain') fk = 'villain';
    else fk = 'character';
  } else {
    fk = kind as EntityKind;
  }
  const root = assignment!.root ?? undefined;
  const slug = assignment!.slug;
  return canonicalPath({ kind: fk, campaignSlug: slug, campaignRoot: root, name });
}

/** Find the campaign assignment for a note by longest source-prefix match. */
function findCampaignForNote(
  sourcePath: string,
  assignments: CampaignAssignment[],
): CampaignAssignment | null {
  if (assignments.length === 0) return null;
  // Prefer the longest matching prefix (most specific wins).
  let best: CampaignAssignment | null = null;
  for (const a of assignments) {
    if (
      a.sourcePrefix === '' ||
      sourcePath === a.sourcePrefix ||
      sourcePath.startsWith(a.sourcePrefix + '/')
    ) {
      if (!best || a.sourcePrefix.length > best.sourcePrefix.length) best = a;
    }
  }
  // Fall back to catch-all assignment (sourcePrefix === '') if no specific match.
  if (!best) best = assignments.find((a) => a.sourcePrefix === '') ?? null;
  return best;
}

/** Strip dates, "backup", underscores etc. from a raw folder name. */
function cleanFolderName(raw: string): string {
  return raw
    .replace(/[_-]/g, ' ')
    .replace(/\b(backup|export|copy|v\d+|\d{4}[-_]\d{2}[-_]\d{2})\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'My Campaign';
}

/** Resolve a DM-provided name to an existing campaign or create a new one. */
function resolveOrCreateCampaign(
  job: ImportJob,
  existing: Array<{ slug: string; name: string; folderPath: string }>,
  rawName: string,
  sourcePrefix: string,
  setActivity: (msg: string) => void,
): CampaignAssignment {
  const cleaned = rawName.trim().replace(/^["']|["']$/g, '');
  const matched = existing.find(
    (c) =>
      c.name.toLowerCase() === cleaned.toLowerCase() ||
      c.slug === slugify(cleaned),
  );
  if (matched) {
    // Even for existing campaigns, make sure every canonical subfolder
    // (Quests, Loot, etc.) is visible in the sidebar — user wants every
    // option present regardless of whether content lands in it.
    ensureCampaignSubfolders(job.groupId, matched.slug);
    // Guarantee the index.md exists so summary-note merging in the entity
    // phase has a target. `ensureIndexNote` is a no-op if present.
    ensureIndexNote(job.groupId, job.createdBy, matched.folderPath, matched.name);
    return { name: matched.name, slug: matched.slug, root: matched.folderPath, sourcePrefix };
  }
  const name = cleaned || 'My Campaign';
  const slug = slugify(name);
  const root = `Campaigns/${slug}`;
  setActivity(`Creating campaign "${name}"…`);
  createCampaignSkeleton(job, name, slug);
  return { name, slug, root, sourcePrefix };
}

/** Migrate old orch state that used campaignSlug/campaignRoot instead of
 *  campaignAssignments. Called when resuming a job created before this change. */
function migrateOrch(raw: Record<string, unknown>): OrchestrationState {
  const r = raw as OrchestrationState & {
    campaignSlug?: string | null;
    campaignRoot?: string | null;
  };
  if (!r.campaignAssignments && (r.campaignSlug != null || r.campaignRoot != null)) {
    const slug = r.campaignSlug && r.campaignSlug !== 'none' ? r.campaignSlug : '';
    const root = r.campaignRoot ?? null;
    r.campaignAssignments = slug
      ? [{ name: slug, slug, root, sourcePrefix: '' }]
      : [{ name: '', slug: '', root: null, sourcePrefix: '' }];
  }
  r.campaignAssignments ??= null;
  return r as OrchestrationState;
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

/** Append a "Related" section to the body with:
 *   • a backlink to the note's campaign (or World Lore) hub — every
 *     non-index entity gets exactly one campaign membership edge, so the
 *     graph shows campaigns as radial hubs with incoming member edges.
 *   • backlinks for any frontmatter tag whose slug matches a known
 *     entity's displayName, a campaign slug/name, or World Lore.
 *
 * Idempotent — existing `[[path]]` occurrences in the body (or in a prior
 * Related section) are skipped, so re-running the quality phase does not
 * duplicate links. */
function enrichWithHubLinks(
  body: string,
  frontmatter: Record<string, unknown>,
  createdPath: string,
  assignment: CampaignAssignment | null,
  tagEntityMap: Map<string, EntityIndexEntry>,
): string {
  // Index notes are hubs themselves — don't link them to themselves.
  const isIndex = /\/index\.md$/i.test(createdPath);

  const wanted: Array<{ path: string; label: string }> = [];

  if (!isIndex) {
    const hubPath = assignment?.root
      ? `${assignment.root}/index.md`
      : 'World Lore/index.md';
    const hubLabel = assignment?.name || 'World Lore';
    wanted.push({ path: hubPath, label: hubLabel });
  }

  const tags = readTagList(frontmatter.tags);
  const seen = new Set<string>(wanted.map((l) => l.path));
  for (const tag of tags) {
    const match = tagEntityMap.get(slugify(tag));
    if (!match) continue;
    if (match.canonicalPath === createdPath) continue;
    if (seen.has(match.canonicalPath)) continue;
    wanted.push({ path: match.canonicalPath, label: match.displayName });
    seen.add(match.canonicalPath);
  }

  // Drop anything already linked anywhere in the body (with or without .md).
  const fresh = wanted.filter((l) => {
    const noExt = l.path.replace(/\.md$/i, '');
    return !body.includes(`[[${l.path}`) && !body.includes(`[[${noExt}`);
  });
  if (fresh.length === 0) return body;

  const section =
    `\n\n---\n**Related:** ` +
    fresh
      .map((l) => `[[${l.path.replace(/\.md$/i, '')}|${l.label}]]`)
      .join(' · ') +
    '\n';
  return body.replace(/\s+$/, '') + section;
}

function slugify(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function readTagList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean).map((t) => t.toLowerCase());
  return [];
}
