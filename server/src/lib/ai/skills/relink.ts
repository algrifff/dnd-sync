// Relink skill — final-pass link resolver for Smart Import.
//
// Obsidian-exported vaults carry wikilinks that use the ORIGINAL ZIP
// folder structure: things like `[[Party/Ignys Silverspear]]`,
// `[[NPCs/Kazamir]]`, `[[../Campaign 3/NPCs/Villains/Atoxis]]`. Once
// we've rewritten every note to its canonical path inside the Compendium
// (`Campaigns/campaign-1/People/ignys-silverspear.md`, …), those raw
// wikilinks point nowhere — they live in the DB as orphans.
//
// This skill runs AFTER every note is on disk. It receives one note and
// a full index of `sourcePath → canonicalPath` for every other imported
// entity, and returns a list of link-level replacements so the caller
// can rewrite the markdown in-place without touching surrounding prose.
//
// We use structured find-and-replace (not whole-body rewrite) so the
// model cannot hallucinate or delete content — its only freedom is to
// choose which wikilink maps to which canonical path.

import { generateStructured } from '../openai';
import type { TokenUsage } from '../pricing';

export type EntityIndexEntry = {
  sourcePath: string;
  canonicalPath: string;
  displayName: string;
  kind: string;
};

export type RelinkInput = {
  /** Original ZIP path for the note being processed. */
  sourcePath: string;
  /** New canonical path the note was written to. */
  canonicalPath: string;
  /** Display name (title) of this note. */
  displayName: string;
  /** Raw markdown body (no frontmatter). */
  content: string;
  /** Full index of every imported note so the AI can resolve cross-refs. */
  entityIndex: EntityIndexEntry[];
};

export type LinkReplacement = {
  /** The full original wikilink text as it appears in the body, including
   *  the surrounding `[[` `]]`. The caller does a literal string replace. */
  original: string;
  /** The replacement text — either a canonical `[[path|anchor]]` wikilink
   *  or, when unresolved, the original string unchanged. */
  replacement: string;
  /** Whether the link was resolved to an index entry. */
  resolved: boolean;
  /** One-line explanation for debugging. */
  reason: string;
};

export type RelinkResult = {
  replacements: LinkReplacement[];
};

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    replacements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          original: { type: 'string' },
          replacement: { type: 'string' },
          resolved: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['original', 'replacement', 'resolved', 'reason'],
      },
    },
  },
  required: ['replacements'],
};

export async function runRelink(
  input: RelinkInput,
  opts: { signal?: AbortSignal } = {},
): Promise<{
  result: RelinkResult;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}> {
  const req: Parameters<typeof generateStructured<RelinkResult>>[0] = {
    systemPrompt: buildSystem(),
    userContent: buildUserContent(input),
    schema: SCHEMA,
    schemaName: 'import_relink',
  };
  if (opts.signal) req.signal = opts.signal;
  const out = await generateStructured<RelinkResult>(req);
  return { result: out.data, usage: out.usage, costUsd: out.costUsd, model: out.model };
}

function buildSystem(): string {
  return [
    'You are the link-resolution skill for a TTRPG campaign-note importer.',
    '',
    'You will receive ONE markdown note and a full index of every other note',
    'imported in the same batch. The note body uses Obsidian-style wikilinks',
    'such as [[target]] or [[target|display text]]. The `target` is an',
    'ORIGINAL ZIP path — it is NOT the canonical path the note has been',
    'rewritten to live at inside the vault.',
    '',
    'Your job: identify EVERY wikilink in the body and return one',
    'replacement per link that rewrites it to point at the correct',
    'canonical path from the entity index.',
    '',
    'Resolution rules:',
    '  1. Relative paths ("./", "../", or a bare "Folder/Name") resolve',
    '     against the SOURCE folder of the current note.',
    '  2. Bare basenames like [[Kazamir]] match against an index entry',
    '     whose sourcePath ends with "/Kazamir.md" or whose displayName',
    '     equals "Kazamir" (case-insensitive).',
    '  3. Cross-campaign references like [[../Campaign 3/NPCs/Villains/Atoxis]]',
    '     must resolve to an index entry whose sourcePath ends with that',
    '     path fragment after collapsing "..".',
    '  4. When you find a match, the replacement is:',
    '       [[canonicalPath|anchorText]]',
    '     where anchorText is the display text from the original pipe, or',
    '     the last path segment of the target when there is no pipe.',
    '  5. If a wikilink CANNOT be resolved to any index entry, set',
    '     resolved=false and put the original string as the replacement',
    '     unchanged. Never invent a target. Never delete the link.',
    '',
    'Output rules:',
    '  - Include EVERY wikilink occurrence from the body, in order.',
    '  - `original` must match the wikilink text verbatim, INCLUDING the',
    '    surrounding [[ ]] brackets, so the caller can do a literal',
    '    string-replace.',
    '  - Do not rewrite prose around the links — the caller edits only the',
    '    wikilink tokens you return.',
    '  - `reason` is one short sentence — "matched by relative path" /',
    '    "basename match on displayName" / "no match in index" etc.',
  ].join('\n');
}

function buildUserContent(input: RelinkInput): string {
  // Bound the index size — even a big vault import rarely needs more
  // than a few hundred entries in scope for any one note, and the
  // prompt cost scales linearly.
  const MAX_INDEX = 400;
  const indexLines = input.entityIndex
    .slice(0, MAX_INDEX)
    .map(
      (e) =>
        `  ${e.sourcePath} => ${e.canonicalPath} (${e.kind}: "${e.displayName}")`,
    );
  const overflow =
    input.entityIndex.length > MAX_INDEX
      ? `  … +${input.entityIndex.length - MAX_INDEX} more entries omitted`
      : '';

  const body =
    input.content.length > 12000
      ? input.content.slice(0, 12000) + '\n\n[... truncated ...]'
      : input.content;

  return [
    `Source path (original ZIP): ${input.sourcePath}`,
    `Canonical path (this note's new home): ${input.canonicalPath}`,
    `Display name: ${input.displayName}`,
    '',
    'Entity index (sourcePath => canonicalPath):',
    indexLines.join('\n'),
    overflow,
    '',
    'Note body:',
    body,
  ]
    .filter((l) => l !== '')
    .join('\n');
}
