// Classifier skill — first pass of an import. Picks the kind (and
// role, for characters), display name, canonical vault path, and all
// the metadata that isn't specific to a single sheet template: tags,
// wikilinks, associated images, portrait.
//
// Keeps its scope narrow so the classifier prompt stays short — a
// focused instruction set produces more consistent kind picks than
// the single mega-prompt from Phase 1c.

import { generateStructured } from '../openai';
import type { TokenUsage } from '../pricing';
import {
  renderContextBlock,
  renderUserBlock,
  type ImportSkillContext,
} from './common';

export type ClassifyResult = {
  kind: 'character' | 'location' | 'item' | 'session' | 'lore' | 'plain';
  role: 'pc' | 'npc' | 'ally' | 'villain' | null;
  confidence: number;
  displayName: string;
  canonicalPath: string;
  tags: string[];
  wikilinks: Array<{ anchorText: string; target: string }>;
  associatedImages: string[];
  portraitImage: string | null;
  rationale: string;
};

export type ClassifyInput = {
  filename: string;
  folderPath: string;
  content: string;
  existingFrontmatter: Record<string, unknown>;
  context: ImportSkillContext;
};

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
    'tags',
    'wikilinks',
    'associated_images',
    'portrait_image',
    'rationale',
  ],
};

type RawOutput = {
  kind: ClassifyResult['kind'];
  role: ClassifyResult['role'];
  confidence: number;
  display_name: string;
  canonical_path: string;
  tags: string[];
  wikilinks: Array<{ anchor_text: string; target: string }>;
  associated_images: string[];
  portrait_image: string | null;
  rationale: string;
};

export async function runClassify(
  input: ClassifyInput,
  opts: { signal?: AbortSignal } = {},
): Promise<{
  result: ClassifyResult;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}> {
  const systemPrompt = buildSystem(input.context);
  const userContent = renderUserBlock({
    filename: input.filename,
    folderPath: input.folderPath,
    content: input.content,
    existingFrontmatter: input.existingFrontmatter,
    knownNotePaths: input.context.knownNotePaths,
    knownImageBasenames: input.context.knownImageBasenames,
  });

  const req: Parameters<typeof generateStructured<RawOutput>>[0] = {
    systemPrompt,
    userContent,
    schema: SCHEMA,
    schemaName: 'import_classify',
  };
  if (opts.signal) req.signal = opts.signal;
  const out = await generateStructured<RawOutput>(req);

  const result: ClassifyResult = {
    kind: out.data.kind,
    role: out.data.role,
    confidence: clamp01(out.data.confidence),
    displayName: out.data.display_name,
    canonicalPath: out.data.canonical_path,
    tags: normaliseTags(out.data.tags),
    wikilinks: out.data.wikilinks.map((w) => ({
      anchorText: w.anchor_text,
      target: w.target,
    })),
    associatedImages: out.data.associated_images,
    portraitImage: out.data.portrait_image,
    rationale: out.data.rationale,
  };

  return { result, usage: out.usage, costUsd: out.costUsd, model: out.model };
}

function buildSystem(ctx: ImportSkillContext): string {
  return [
    'You are a careful D&D campaign-note classifier.',
    'Given one note from a bulk import, decide what kind of entry it is and where it should live in the vault.',
    '',
    'Kinds:',
    '  character - a PC, NPC, ally, or villain. Set role accordingly.',
    '  location  - city, town, dungeon, landmark, plane, region.',
    '  item      - magic item, weapon, treasure, relic.',
    '  session   - a dated session log.',
    '  lore      - worldbuilding: factions, history, cosmology, deities.',
    '  plain     - anything you cannot classify confidently.',
    '',
    renderContextBlock(ctx),
    '',
    'Hard rules:',
    '  - Only propose a wikilink if its target is in the known note paths list. Never fabricate.',
    '  - Only reference an image basename that is in the known images list.',
    '  - Prefer existing vault tags; coin new ones only when no existing tag fits, and cap new tags at 1-2 per note.',
    '  - Total tags: 2-5 per note. Lowercase, hyphen-separated.',
    '  - canonical_path must follow the folder conventions above. Filename: "<Display Name>.md" (character / location / item / lore) or "<YYYY-MM-DD>-<slug>.md" (session).',
    '  - If confidence < 0.4, return kind="plain" with canonical_path equal to the original note path so nothing moves.',
    '  - Do NOT include sheet fields in the response — a separate skill extracts them.',
  ].join('\n');
}

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
  return [...out].slice(0, 8);
}
