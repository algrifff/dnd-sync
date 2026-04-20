// Shared types, prompt fragments, and schema helpers for the import
// skill suite. Each skill (classify / extract-<kind> / merge) lives
// in its own file but pulls its vault-level context + schema
// builders from here so they stay consistent.

import type { TemplateField, TemplateKind } from '../../templates';
import { getTemplate } from '../../templates';

export type ImportSkillContext = {
  /** Campaign slug the DM wants the drop to land under (if any). */
  targetCampaignSlug: string | null;
  /** Every note path already in the vault + every note in this drop
   *  so the model only ever proposes real wikilink targets. */
  knownNotePaths: string[];
  /** Image basenames the drop contains. */
  knownImageBasenames: string[];
  /** Tags already used in the vault — encourages reuse. */
  existingVaultTags: string[];
  /** Folder conventions rendered per campaign — see conventions.ts. */
  conventions: FolderConventions;
};

export type FolderConventions = {
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

export function renderConventions(c: FolderConventions): string {
  return [
    c.campaignRoot && `Campaign root:    ${c.campaignRoot}`,
    `PCs folder:       ${c.pcsFolder}`,
    `NPCs folder:      ${c.npcsFolder}`,
    `Allies folder:    ${c.alliesFolder}`,
    `Villains folder:  ${c.villainsFolder}`,
    `Sessions folder:  ${c.sessionsFolder}`,
    `Locations folder: ${c.locationsFolder}`,
    `Items folder:     ${c.itemsFolder}`,
    `Lore folder:      ${c.loreFolder}`,
    `Assets/portraits: ${c.assetsPortraits}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function defaultConventions(
  campaignSlug: string | null,
): FolderConventions {
  const root = campaignSlug ? `Campaigns/${slugToTitle(campaignSlug)}` : null;
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

// ── Template-driven schema builders ────────────────────────────────────

/** Build the `sheet` subschema for a given kind directly from the
 *  live template definition. Keeps the extract skills in lockstep
 *  with whatever the admin has configured. */
export function sheetSchemaFor(
  kind: TemplateKind,
): Record<string, unknown> {
  const template = getTemplate(kind);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (template) {
    for (const section of template.schema.sections) {
      for (const field of section.fields) {
        properties[field.id] = jsonTypeForField(field);
        required.push(field.id);
      }
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

function jsonTypeForField(field: TemplateField): Record<string, unknown> {
  // All fields are nullable so the model can explicitly signal "don't
  // know" without stuffing fake values. Strict mode validates the
  // union.
  switch (field.type) {
    case 'text':
    case 'longtext':
      return { type: ['string', 'null'] };
    case 'integer':
      return { type: ['integer', 'null'] };
    case 'number':
      return { type: ['number', 'null'] };
    case 'boolean':
      return { type: ['boolean', 'null'] };
    case 'enum': {
      const options = (field.options ?? []).filter(
        (o): o is string => typeof o === 'string',
      );
      // `null` must be a valid enum value too for the union to validate.
      return {
        type: ['string', 'null'],
        enum: [...options, null],
      };
    }
    case 'list<text>':
      return { type: 'array', items: { type: 'string' } };
    default:
      return { type: ['string', 'null'] };
  }
}

// ── Prompt fragments reused across skills ──────────────────────────────

export function renderContextBlock(ctx: ImportSkillContext): string {
  const tagsHint =
    ctx.existingVaultTags.length > 0
      ? `Existing tags in this vault (prefer reuse):\n${ctx.existingVaultTags
          .slice(0, 120)
          .join(', ')}`
      : 'The vault currently has no tags — coin new ones sparingly.';

  return [
    'Folder conventions in this vault:',
    renderConventions(ctx.conventions),
    '',
    tagsHint,
  ].join('\n');
}

export function renderUserBlock(input: {
  filename: string;
  folderPath: string;
  content: string;
  existingFrontmatter: Record<string, unknown>;
  knownNotePaths: string[];
  knownImageBasenames: string[];
}): string {
  const fmBlock =
    Object.keys(input.existingFrontmatter).length > 0
      ? `Existing frontmatter:\n${JSON.stringify(input.existingFrontmatter, null, 2)}`
      : 'No existing frontmatter.';

  const body =
    input.content.length > 8000
      ? input.content.slice(0, 8000) + '\n\n[... truncated ...]'
      : input.content;

  const knownPaths =
    input.knownNotePaths.length > 0
      ? input.knownNotePaths.slice(0, 200).join('\n')
      : '(none)';
  const knownImages =
    input.knownImageBasenames.length > 0
      ? input.knownImageBasenames.slice(0, 200).join(', ')
      : '(none)';

  return [
    `Filename: ${input.filename}`,
    `Folder path (original): ${input.folderPath || '(root)'}`,
    '',
    fmBlock,
    '',
    'Known note paths (wikilink candidates):',
    knownPaths,
    '',
    'Known image basenames:',
    knownImages,
    '',
    'Note body:',
    body,
  ].join('\n');
}
