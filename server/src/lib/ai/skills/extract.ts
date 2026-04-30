// Per-kind extract skills. Each one is a focused prompt that knows
// the specific shape + conventions for a single kind and pulls its
// JSON schema directly from the live template registered for that
// kind — so an admin tweaking the template at /settings/templates
// changes what extract asks for on the very next run.
//
// Public surface: one function per kind. All share the same input
// type + return shape so the analyse worker can call them
// uniformly.

import { generateStructured } from '../openai';
import type { TokenUsage } from '../pricing';
import type { TemplateKind } from '../../templates';
import { parseCharacter } from '../../character-parser';
import {
  renderContextBlock,
  renderUserBlock,
  sheetSchemaFor,
  type ImportSkillContext,
} from './common';

export type ExtractInput = {
  filename: string;
  folderPath: string;
  content: string;
  existingFrontmatter: Record<string, unknown>;
  context: ImportSkillContext;
  /** The display name the classifier produced — seeds sheet.name and
   *  gives the extractor a stable reference for in-prose mentions. */
  displayName: string;
};

export type ExtractResult = {
  sheet: Record<string, unknown>;
};

// ── Per-kind entrypoints ───────────────────────────────────────────────

export async function extractPc(
  input: ExtractInput,
  opts: { signal?: AbortSignal } = {},
): Promise<{
  result: ExtractResult;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}> {
  return runCharacterExtract('pc', SYSTEM_PC, input, opts);
}

export async function extractNpc(
  input: ExtractInput,
  opts: { signal?: AbortSignal } = {},
) {
  return runCharacterExtract('npc', SYSTEM_NPC, input, opts);
}

export async function extractAlly(
  input: ExtractInput,
  opts: { signal?: AbortSignal } = {},
) {
  return runCharacterExtract('ally', SYSTEM_ALLY, input, opts);
}

export async function extractVillain(
  input: ExtractInput,
  opts: { signal?: AbortSignal } = {},
) {
  return runCharacterExtract('villain', SYSTEM_VILLAIN, input, opts);
}

export async function extractLocation(
  input: ExtractInput,
  opts: { signal?: AbortSignal } = {},
) {
  return runExtract('location', SYSTEM_LOCATION, input, opts);
}

export async function extractItem(
  input: ExtractInput,
  opts: { signal?: AbortSignal } = {},
) {
  return runExtract('item', SYSTEM_ITEM, input, opts);
}

export async function extractSession(
  input: ExtractInput,
  opts: { signal?: AbortSignal } = {},
) {
  return runExtract('session', SYSTEM_SESSION, input, opts);
}

// ── Character runner: deterministic parse first, AI for the gaps ──────

/** Decide whether the deterministic parser found enough structured data
 *  to skip the AI call entirely. The hot fields (HP/AC/abilities/class)
 *  are what the SheetHeader and party sidebar key off; if those are all
 *  present the AI extractor adds nothing material and we save tokens.
 */
function parsedSheetIsComplete(sheet: Record<string, unknown>): boolean {
  return (
    sheet.ability_scores != null &&
    sheet.hit_points != null &&
    sheet.armor_class != null &&
    (sheet.classes != null || typeof sheet.class === 'string')
  );
}

async function runCharacterExtract(
  kind: TemplateKind,
  systemSpecific: string,
  input: ExtractInput,
  opts: { signal?: AbortSignal },
): Promise<{
  result: ExtractResult;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}> {
  // 1. Try deterministic table extraction. Fast, free, and accurate
  // when the source has the standard `Field | Value` / `STR | DEX` /
  // `HP | AC | …` markdown tables.
  const parsed = parseCharacter(input.content, {
    defaultPlayer:
      typeof input.existingFrontmatter.player === 'string'
        ? input.existingFrontmatter.player
        : '',
  });
  const parsedSheet =
    (parsed.frontmatter.sheet as Record<string, unknown> | undefined) ?? {};

  if (parsedSheetIsComplete(parsedSheet)) {
    return {
      result: { sheet: dropEmpty(parsedSheet) },
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      costUsd: 0,
      model: 'local-character-parser',
    };
  }

  // 2. AI fallback — fills the gaps the parser couldn't infer (pure-prose
  // backstory pages, atypical layouts). Send the parsed sheet as context
  // so the AI doesn't hallucinate over fields we already know.
  const aiOut = await runExtract(kind, systemSpecific, input, opts);

  // 3. Merge: deterministic parser wins for fields it explicitly set;
  // AI fills blanks. Drops nulls + empty arrays per the runExtract
  // contract.
  const merged: Record<string, unknown> = { ...aiOut.result.sheet };
  for (const [k, v] of Object.entries(parsedSheet)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    merged[k] = v;
  }
  return {
    ...aiOut,
    result: { sheet: merged },
  };
}

function dropEmpty(sheet: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sheet)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

// ── Shared runner ──────────────────────────────────────────────────────

async function runExtract(
  kind: TemplateKind,
  systemSpecific: string,
  input: ExtractInput,
  opts: { signal?: AbortSignal },
): Promise<{
  result: ExtractResult;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}> {
  const schema = wrapSheetSchema(sheetSchemaFor(kind));
  const systemPrompt = buildSystem(systemSpecific, input.context);
  const userContent =
    `Display name assigned by classifier: ${input.displayName}\n\n` +
    renderUserBlock({
      filename: input.filename,
      folderPath: input.folderPath,
      content: input.content,
      existingFrontmatter: input.existingFrontmatter,
      knownNotePaths: input.context.knownNotePaths,
      knownImageBasenames: input.context.knownImageBasenames,
    });

  const req: Parameters<
    typeof generateStructured<{ sheet: Record<string, unknown> }>
  >[0] = {
    systemPrompt,
    userContent,
    schema,
    schemaName: `extract_${kind}`,
  };
  if (opts.signal) req.signal = opts.signal;

  const out = await generateStructured<{ sheet: Record<string, unknown> }>(req);

  // Strip nulls so downstream frontmatter stays clean — the schema
  // requires every field, but the model signals unknowns via null
  // and we don't need those in the yaml.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out.data.sheet)) {
    if (v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    cleaned[k] = v;
  }

  return {
    result: { sheet: cleaned },
    usage: out.usage,
    costUsd: out.costUsd,
    model: out.model,
  };
}

function wrapSheetSchema(
  sheetSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { sheet: sheetSchema },
    required: ['sheet'],
  };
}

function buildSystem(kindSpecific: string, ctx: ImportSkillContext): string {
  return [
    kindSpecific,
    '',
    renderContextBlock(ctx),
    '',
    'Rules:',
    '  - Every property in the `sheet` schema is required. Use null for fields the note does not provide — do NOT invent values.',
    '  - Keep lists as lists; empty is fine. Never comma-join.',
    '  - Prefer values explicit in the note. If the note describes something in prose (e.g. "a grizzled tiefling with a limp"), set the closest structured field (race=tiefling) and leave prose for the body.',
    '  - Do not duplicate the note body in any field.',
  ].join('\n');
}

// ── Per-kind instruction blocks ────────────────────────────────────────

const SYSTEM_PC = [
  'You extract a TTRPG player-character sheet from the given note.',
  'The player (owner) is whoever wrote this note. Leave the `player` field untouched — the app sets it from the creator.',
  'Common signals to look for:',
  '  * class / subclass / level (usually in a header or a stat block)',
  '  * race, background, alignment',
  '  * ability scores (STR/DEX/CON/INT/WIS/CHA — integer, not modifier)',
  '  * HP max, current HP, AC, speed, initiative bonus',
  '  * inventory (list of items), gold (coin total, in gp)',
  '  * current conditions (prone, poisoned, concentrating, …)',
  "If the note's a pure backstory blob, fill the basics (race/class/level) from explicit mentions and leave stats as null — the body remains the character's story.",
].join('\n');

const SYSTEM_NPC = [
  'You extract an NPC sheet from the given note.',
  'Focus on what a GM needs at a glance: a quick tagline ("grizzled innkeeper"), the role they play in the world, where they live, and — if they matter in combat — a stat block.',
  'Leave combat stats null for pure-roleplay NPCs.',
].join('\n');

const SYSTEM_ALLY = [
  'You extract an ally sheet from the given note.',
  'Allies carry NPC fields plus relationship state: disposition (friendly / warm / loyal / sworn), trust (0-10), what the party owes them or they owe the party.',
  'Trust heuristic: casual help = 3-4, fought alongside the party = 5-6, took a bullet = 7-8, sworn bond = 9-10.',
].join('\n');

const SYSTEM_VILLAIN = [
  'You extract a villain sheet from the given note.',
  'Villains carry NPC fields plus ambition and resources: immediate goal (what they want this week), long-term ambition (what they are ultimately building toward), resources (allies, artefacts, strongholds — a list), and a known weakness the party could exploit.',
  'When goals are implied rather than spelled out, infer conservatively — a missing field is better than a fabricated one.',
].join('\n');

const SYSTEM_LOCATION = [
  'You extract a location sheet from the given note.',
  'Capture: the place name, type (city / town / village / dungeon / wilderness / landmark / plane / other), which region it sits in, an approximate population or character ("~12k, mostly dwarves" is a valid string), a one-paragraph summary, and a short list of notable features.',
  'Underground/ruin-style pages usually do not have populations — leave null.',
].join('\n');

const SYSTEM_ITEM = [
  'You extract an item sheet from the given note.',
  'Capture: item name, type (weapon / armor / wondrous / potion / scroll / tool / treasure / other), rarity, whether it requires attunement, weight (lb), value (gp), charges if applicable, a summary, and a list of mechanical properties (e.g. "+1 to attack & damage", "advantage on perception").',
  'Only set rarity if the note is explicit ("rare", "legendary", or a DMG-style callout); prefer null over guessing.',
].join('\n');

const SYSTEM_SESSION = [
  'You extract a session log sheet from the given note.',
  'Capture: session date (YYYY-MM-DD — parse common forms like "Feb 3 2024" and "2024-02-03"), session number if numbered, title if given, the attendees (list of player/character names), a multi-paragraph recap summary, locations visited (list), and outcomes / cliffhangers.',
  'If the note does not carry a date, return null for date rather than inventing one.',
].join('\n');
