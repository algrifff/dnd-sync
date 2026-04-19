// The import classifier skill — one OpenAI call per imported note.
//
// Consumes a single note (filename + body + existing metadata) plus
// vault context (known paths, known image basenames, existing tags,
// target campaign) and returns a structured plan entry: the kind,
// proposed vault path, extracted sheet values (as JSON-encoded
// string since sheets are heterogeneous across kinds), suggested
// tags + wikilinks + images, and a confidence score the UI uses to
// decide what to auto-accept.

import { generateStructured } from './openai';
import type { TokenUsage } from './pricing';

// ── Types ──────────────────────────────────────────────────────────────

export type ImportClassifyContext = {
  /** Which campaign slug new content should land in if the note
   *  doesn't self-identify. `null` if no campaign is in scope. */
  targetCampaignSlug: string | null;
  /** Absolute paths of other notes in this same drop + notes already
   *  in the vault. The skill is told to only propose wikilinks to
   *  paths on this list. */
  knownNotePaths: string[];
  /** Image basenames already present in the drop (not absolute paths —
   *  the model only needs the name to match mentions in prose). */
  knownImageBasenames: string[];
  /** Tags already in use in the vault — encourages reuse. */
  existingVaultTags: string[];
  /** Active folder conventions rendered into prose for the prompt. */
  conventions: FolderConventions;
};

export type FolderConventions = {
  /** Campaign folder root relative to vault root, e.g.
   *  "Campaigns/Campaign 1". Used to anchor character / session /
   *  location paths. */
  campaignRoot: string | null;
  pcsFolder: string;
  npcsFolder: string;
  alliesFolder: string;
  villainsFolder: string;
  sessionsFolder: string;
  locationsFolder: string;
  itemsFolder: string;
  loreFolder: string;
  assetsPortraits: string;
  assetsMaps: string;
  assetsTokens: string;
};

export type ImportClassifyInput = {
  filename: string;
  folderPath: string;
  content: string;
  existingFrontmatter: Record<string, unknown>;
  context: ImportClassifyContext;
};

export type ImportClassifyResult = {
  kind: 'character' | 'location' | 'item' | 'session' | 'lore' | 'plain';
  role: 'pc' | 'npc' | 'ally' | 'villain' | null;
  confidence: number;
  displayName: string;
  canonicalPath: string;
  sheet: Record<string, unknown>;
  tags: string[];
  wikilinks: Array<{ anchorText: string; target: string }>;
  associatedImages: string[];
  portraitImage: string | null;
  rationale: string;
};

// ── Default folder conventions ─────────────────────────────────────────

export function defaultConventions(
  campaignSlug: string | null,
): FolderConventions {
  const root = campaignSlug
    ? `Campaigns/${slugToTitle(campaignSlug)}`
    : null;
  return {
    campaignRoot: root,
    pcsFolder: root ? `${root}/Characters/PCs` : 'Characters/PCs',
    npcsFolder: root ? `${root}/Characters/NPCs` : 'Characters/NPCs',
    alliesFolder: root ? `${root}/Characters/Allies` : 'Characters/Allies',
    villainsFolder: root
      ? `${root}/Characters/Villains`
      : 'Characters/Villains',
    sessionsFolder: root ? `${root}/Sessions` : 'Sessions',
    locationsFolder: root ? `${root}/Locations` : 'Lore/Locations',
    itemsFolder: root ? `${root}/Items` : 'Lore/Items',
    loreFolder: 'Lore',
    assetsPortraits: 'Assets/Portraits',
    assetsMaps: 'Assets/Maps',
    assetsTokens: 'Assets/Tokens',
  };
}

function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map((p) => (p.length > 0 ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(' ');
}

// ── Schema ─────────────────────────────────────────────────────────────

/** Strict JSON schema for the structured output. OpenAI's strict mode
 *  requires every property to be listed in `required` and
 *  `additionalProperties: false`. Optional fields are emulated by
 *  allowing `null` as a value. The `sheet` bag is emitted as a JSON-
 *  encoded string because each kind has a different field set and the
 *  strict mode doesn't allow truly free-form objects. */
const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: ['character', 'location', 'item', 'session', 'lore', 'plain'],
    },
    role: {
      type: ['string', 'null'],
      enum: ['pc', 'npc', 'ally', 'villain', null],
    },
    confidence: { type: 'number' },
    display_name: { type: 'string' },
    canonical_path: { type: 'string' },
    // JSON-encoded object of sheet fields (varies by kind). Empty
    // string or "{}" when the kind has no structured sheet.
    sheet_json: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    wikilinks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          anchor_text: { type: 'string' },
          target: { type: 'string' },
        },
        required: ['anchor_text', 'target'],
      },
    },
    associated_images: { type: 'array', items: { type: 'string' } },
    portrait_image: { type: ['string', 'null'] },
    rationale: { type: 'string' },
  },
  required: [
    'kind',
    'role',
    'confidence',
    'display_name',
    'canonical_path',
    'sheet_json',
    'tags',
    'wikilinks',
    'associated_images',
    'portrait_image',
    'rationale',
  ],
};

type RawOutput = {
  kind: ImportClassifyResult['kind'];
  role: ImportClassifyResult['role'];
  confidence: number;
  display_name: string;
  canonical_path: string;
  sheet_json: string;
  tags: string[];
  wikilinks: Array<{ anchor_text: string; target: string }>;
  associated_images: string[];
  portrait_image: string | null;
  rationale: string;
};

// ── Public API ─────────────────────────────────────────────────────────

export async function classifyImportNote(
  input: ImportClassifyInput,
  opts: { signal?: AbortSignal } = {},
): Promise<{ result: ImportClassifyResult; usage: TokenUsage; costUsd: number; model: string }> {
  const systemPrompt = buildSystemPrompt(input.context);
  const userContent = buildUserContent(input);

  const req: Parameters<typeof generateStructured<RawOutput>>[0] = {
    systemPrompt,
    userContent,
    schema: SCHEMA,
    schemaName: 'import_classification',
  };
  if (opts.signal) req.signal = opts.signal;
  const out = await generateStructured<RawOutput>(req);

  // Parse the sheet_json string (which the model produced in order to
  // route around strict-schema's no-free-form-objects rule).
  let sheet: Record<string, unknown> = {};
  if (out.data.sheet_json && out.data.sheet_json !== '{}') {
    try {
      const p = JSON.parse(out.data.sheet_json) as unknown;
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        sheet = p as Record<string, unknown>;
      }
    } catch {
      /* empty sheet — defaults apply at apply-time */
    }
  }

  const result: ImportClassifyResult = {
    kind: out.data.kind,
    role: out.data.role,
    confidence: clamp01(out.data.confidence),
    displayName: out.data.display_name,
    canonicalPath: out.data.canonical_path,
    sheet,
    tags: normaliseTags(out.data.tags),
    wikilinks: out.data.wikilinks.map((w) => ({
      anchorText: w.anchor_text,
      target: w.target,
    })),
    associatedImages: out.data.associated_images,
    portraitImage: out.data.portrait_image,
    rationale: out.data.rationale,
  };

  return {
    result,
    usage: out.usage,
    costUsd: out.costUsd,
    model: out.model,
  };
}

// ── Prompt construction ────────────────────────────────────────────────

function buildSystemPrompt(ctx: ImportClassifyContext): string {
  const tagsHint =
    ctx.existingVaultTags.length > 0
      ? `Existing tags in this vault (prefer reuse):\n${ctx.existingVaultTags.slice(0, 80).join(', ')}`
      : 'The vault currently has no tags — coin new ones sparingly.';

  const convLines = [
    ctx.conventions.campaignRoot &&
      `Campaign root: ${ctx.conventions.campaignRoot}`,
    `PCs folder:      ${ctx.conventions.pcsFolder}`,
    `NPCs folder:     ${ctx.conventions.npcsFolder}`,
    `Allies folder:   ${ctx.conventions.alliesFolder}`,
    `Villains folder: ${ctx.conventions.villainsFolder}`,
    `Sessions folder: ${ctx.conventions.sessionsFolder}`,
    `Locations:       ${ctx.conventions.locationsFolder}`,
    `Items:           ${ctx.conventions.itemsFolder}`,
    `Lore:            ${ctx.conventions.loreFolder}`,
    `Assets/portraits: ${ctx.conventions.assetsPortraits}`,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    `You are a careful D&D campaign-note organiser. Given one note from a bulk import, classify it and extract structured fields.`,
    ``,
    `Kinds you may choose:`,
    `  character - a PC, NPC, ally, or villain (set role accordingly).`,
    `  location  - city, town, dungeon, landmark, plane, region.`,
    `  item      - magic item, weapon, treasure, relic.`,
    `  session   - a dated session log.`,
    `  lore      - worldbuilding: factions, history, cosmology, deities.`,
    `  plain     - anything you can't classify with confidence (leave in place).`,
    ``,
    `Folder conventions in this vault:`,
    convLines,
    ``,
    `Hard rules:`,
    `  - Only propose a wikilink if its target is in the provided list of known note paths. NEVER fabricate.`,
    `  - Only propose an associated_image basename from the provided list of known images.`,
    `  - Prefer existing vault tags. Only coin a new tag when nothing fits — and keep new tags to 1-2 per note.`,
    `  - Total tags per note: 2-5. Use lowercase, hyphen-separated tokens (e.g. "moon-touched").`,
    `  - canonical_path must use the folder conventions above. Filename: "<Display Name>.md" (character / location / item / lore) or "<YYYY-MM-DD>-<slug>.md" (session).`,
    `  - sheet_json must be a JSON string of the structured fields for the chosen kind. {} if none. Do not invent fields outside the sheet convention.`,
    `  - If confidence < 0.4 return kind="plain" with canonical_path equal to the source path so nothing is reorganised.`,
    ``,
    tagsHint,
  ].join('\n');
}

function buildUserContent(input: ImportClassifyInput): string {
  const fmBlock =
    Object.keys(input.existingFrontmatter).length > 0
      ? `Existing frontmatter (already set on this note):\n${JSON.stringify(input.existingFrontmatter, null, 2)}`
      : 'No existing frontmatter.';

  // Keep content bounded — classification doesn't need the whole
  // body on very long notes. Cap at 8k chars.
  const body = input.content.length > 8000
    ? input.content.slice(0, 8000) + '\n\n[... truncated for classification ...]'
    : input.content;

  const knownPaths =
    input.context.knownNotePaths.length > 0
      ? input.context.knownNotePaths.slice(0, 150).join('\n')
      : '(none yet)';

  const knownImages =
    input.context.knownImageBasenames.length > 0
      ? input.context.knownImageBasenames.slice(0, 150).join(', ')
      : '(none)';

  return [
    `Filename: ${input.filename}`,
    `Folder path (original): ${input.folderPath || '(root)'}`,
    ``,
    fmBlock,
    ``,
    `Known note paths (wikilink candidates):`,
    knownPaths,
    ``,
    `Known image basenames:`,
    knownImages,
    ``,
    `Note body:`,
    body,
  ].join('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normaliseTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().replace(/^#/, '').toLowerCase();
    if (t.length === 0) continue;
    out.add(t);
  }
  // Cap at 8 to guard against a runaway tag party.
  return [...out].slice(0, 8);
}
