// Merge skill — when an incoming note's canonical path collides
// with an existing note, we hand both to the model and ask it to
// produce a single coherent merged result.
//
// This is the opposite of the dumb append behaviour from Phase 1e.
// The model can:
//   - reconcile duplicated stat blocks (keep the more authoritative)
//   - interleave backstory paragraphs rather than concatenate
//   - union tags + wikilinks, dropping duplicates
//   - keep the existing sheet values on ambiguous fields, pulling in
//     incoming values only for blanks
//
// We still enforce the hard rule from the plan: existing frontmatter
// keys (other than sheet + tags) win per-key. The model returns
// incoming → existing diff suggestions that we merge on our side so
// arbitrary fields never get overwritten silently.

import { generateStructured } from '../openai';
import type { TokenUsage } from '../pricing';

export type MergeInput = {
  path: string;
  existing: {
    frontmatter: Record<string, unknown>;
    body: string;
  };
  incoming: {
    frontmatter: Record<string, unknown>;
    body: string;
    sourceFilename: string;
  };
};

export type MergeResult = {
  /** Final body — a single coherent markdown document, not an append.
   *  The model decides structure (interleave vs concatenate vs
   *  rewrite) based on what makes the result most readable. */
  mergedBody: string;
  /** Fields the model thinks should be added / updated on the
   *  frontmatter. Our caller enforces the "existing wins per-key"
   *  rule on top of these, so nothing the DM set gets clobbered. */
  frontmatterSuggestions: Record<string, unknown>;
  /** Tags the merged note should carry (union + any new implied). */
  tags: string[];
  /** One-liner for the DM on what changed. */
  summary: string;
};

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merged_body: { type: 'string' },
    // Free-form suggestions surfaced to the caller for selective
    // application; sheet-level merging happens here (sub-object is
    // fine under strict mode when additionalProperties is left
    // permissive inside).
    frontmatter_suggestions_json: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['merged_body', 'frontmatter_suggestions_json', 'tags', 'summary'],
};

type RawOutput = {
  merged_body: string;
  frontmatter_suggestions_json: string;
  tags: string[];
  summary: string;
};

export async function runMerge(
  input: MergeInput,
  opts: { signal?: AbortSignal } = {},
): Promise<{
  result: MergeResult;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}> {
  const systemPrompt = buildSystem();
  const userContent = buildUser(input);

  const req: Parameters<typeof generateStructured<RawOutput>>[0] = {
    systemPrompt,
    userContent,
    schema: SCHEMA,
    schemaName: 'merge_notes',
  };
  if (opts.signal) req.signal = opts.signal;

  const out = await generateStructured<RawOutput>(req);

  let suggestions: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(out.data.frontmatter_suggestions_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      suggestions = parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore — empty suggestions */
  }

  return {
    result: {
      mergedBody: out.data.merged_body,
      frontmatterSuggestions: suggestions,
      tags: normaliseTags(out.data.tags),
      summary: out.data.summary,
    },
    usage: out.usage,
    costUsd: out.costUsd,
    model: out.model,
  };
}

function buildSystem(): string {
  return [
    'You merge two versions of the same D&D note into one.',
    'You will receive an existing note (frontmatter + body) and an incoming note (frontmatter + body) that the user wants to fold into it.',
    '',
    'Rules:',
    '  1. The existing note is authoritative. Preserve everything it says unless it is a pure duplicate of what the incoming note also says.',
    '  2. Deduplicate: if the same stat block / description / list appears in both, keep one copy — prefer the existing version.',
    '  3. Integrate the incoming body into a single coherent document — do not just append with a rule separator. Pull out novel information and slot it where it belongs (stat block in one place, backstory in another). If the incoming note is mostly noise, say so in summary and return the existing body unchanged.',
    '  4. Frontmatter suggestions: emit a JSON object string of fields you think should be set on the merged note. Only include additions + clearly-missing fields. The caller will NOT overwrite existing values; it merges your suggestions under the existing frontmatter.',
    '  5. Merge `sheet` entries field-by-field: existing values win, your additions fill blanks only.',
    '  6. Union tags. Drop duplicates. Keep to 2-5 distinct tags total.',
    '  7. summary: one short sentence for the DM, e.g. "added stat block and two new paragraphs of backstory; no conflicts".',
  ].join('\n');
}

function buildUser(input: MergeInput): string {
  const existingFm =
    Object.keys(input.existing.frontmatter).length > 0
      ? JSON.stringify(input.existing.frontmatter, null, 2)
      : '(empty)';
  const incomingFm =
    Object.keys(input.incoming.frontmatter).length > 0
      ? JSON.stringify(input.incoming.frontmatter, null, 2)
      : '(empty)';

  // Cap bodies at 12k chars each — a 24k-char merge is more than any
  // realistic note pair and keeps the per-merge cost bounded.
  const existingBody = truncate(input.existing.body, 12_000);
  const incomingBody = truncate(input.incoming.body, 12_000);

  return [
    `Target path: ${input.path}`,
    `Incoming source: ${input.incoming.sourceFilename}`,
    '',
    '=== Existing frontmatter ===',
    existingFm,
    '',
    '=== Existing body ===',
    existingBody,
    '',
    '=== Incoming frontmatter ===',
    incomingFm,
    '',
    '=== Incoming body ===',
    incomingBody,
  ].join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n[... truncated ...]';
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
