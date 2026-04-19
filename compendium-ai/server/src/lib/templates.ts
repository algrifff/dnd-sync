// Note templates.
//
// A template defines the shape of a structured note's frontmatter for
// a given kind (PC, NPC, Ally, Villain, Session). The schema is edited
// by admins in /settings/templates and lives in the server-global
// `note_templates` table — every world shares one copy because most
// campaigns want the same 5e PC sheet / the same session-log shape.
// Players never see or edit templates; they fill in values via the
// character sheet UI (Phase 1d).
//
// This module owns:
//   * The TypeScript types for the schema (TemplateField, Section, …)
//   * DB CRUD helpers for admins + render layers
//   * ensureDefaultTemplates() — seeds the table on first boot with
//     the minimal 5e PC / NPC / Ally / Villain / Session defaults so
//     there's always something to render against.

import { getDb } from './db';

export type TemplateKind =
  | 'pc'
  | 'npc'
  | 'ally'
  | 'villain'
  | 'session'
  | 'item'
  | 'location';

export const TEMPLATE_KINDS: readonly TemplateKind[] = [
  'pc',
  'npc',
  'ally',
  'villain',
  'session',
  'item',
  'location',
] as const;

export type TemplateFieldType =
  | 'text'
  | 'longtext'
  | 'integer'
  | 'number'
  | 'enum'
  | 'boolean'
  | 'list<text>';

export type TemplateField = {
  id: string;
  label: string;
  type: TemplateFieldType;
  required?: boolean | undefined;
  default?: string | number | boolean | string[] | undefined;
  min?: number | undefined;
  max?: number | undefined;
  options?: string[] | undefined;
  hint?: string | undefined;
  /** When true, any authenticated user may write this field on any
   *  character sheet (not just the owner). For shared combat state —
   *  HP-current, conditions, death saves. */
  playerEditable?: boolean | undefined;
};

export type TemplateSection = {
  id: string;
  label: string;
  fields: TemplateField[];
};

export type TemplateSchema = {
  version: number;
  sections: TemplateSection[];
};

export type NoteTemplate = {
  kind: TemplateKind;
  name: string;
  schema: TemplateSchema;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
};

type TemplateRow = {
  kind: string;
  name: string;
  schema_json: string;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
};

function rowToTemplate(r: TemplateRow): NoteTemplate {
  return {
    kind: r.kind as TemplateKind,
    name: r.name,
    schema: JSON.parse(r.schema_json) as TemplateSchema,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

// ── Reads ──────────────────────────────────────────────────────────────

export function getTemplate(kind: TemplateKind): NoteTemplate | null {
  const row = getDb()
    .query<TemplateRow, [string]>(
      `SELECT kind, name, schema_json, created_at, updated_at, updated_by
         FROM note_templates WHERE kind = ?`,
    )
    .get(kind);
  return row ? rowToTemplate(row) : null;
}

export function listTemplates(): NoteTemplate[] {
  return getDb()
    .query<TemplateRow, []>(
      `SELECT kind, name, schema_json, created_at, updated_at, updated_by
         FROM note_templates
         ORDER BY kind`,
    )
    .all()
    .map(rowToTemplate);
}

// ── Writes (admin-gated at the route layer) ────────────────────────────

export function upsertTemplate(
  kind: TemplateKind,
  name: string,
  schema: TemplateSchema,
  updatedBy: string | null,
): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO note_templates
         (kind, name, schema_json, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET
         name = excluded.name,
         schema_json = excluded.schema_json,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .run(kind, name, JSON.stringify(schema), now, now, updatedBy);
}

// ── Defaults + first-boot seed ─────────────────────────────────────────

const DEFAULT_PC_SCHEMA: TemplateSchema = {
  version: 1,
  sections: [
    {
      id: 'basics',
      label: 'Basics',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'level', label: 'Level', type: 'integer', min: 1, max: 20, default: 1 },
        { id: 'class', label: 'Class', type: 'text' },
        { id: 'race', label: 'Race', type: 'text' },
        { id: 'background', label: 'Background', type: 'text' },
        { id: 'alignment', label: 'Alignment', type: 'text' },
      ],
    },
    {
      id: 'abilities',
      label: 'Ability scores',
      fields: [
        { id: 'str', label: 'STR', type: 'integer', min: 1, max: 30, default: 10 },
        { id: 'dex', label: 'DEX', type: 'integer', min: 1, max: 30, default: 10 },
        { id: 'con', label: 'CON', type: 'integer', min: 1, max: 30, default: 10 },
        { id: 'int', label: 'INT', type: 'integer', min: 1, max: 30, default: 10 },
        { id: 'wis', label: 'WIS', type: 'integer', min: 1, max: 30, default: 10 },
        { id: 'cha', label: 'CHA', type: 'integer', min: 1, max: 30, default: 10 },
      ],
    },
    {
      id: 'combat',
      label: 'Combat',
      fields: [
        { id: 'hp_max', label: 'HP max', type: 'integer', min: 1 },
        {
          id: 'hp_current',
          label: 'HP current',
          type: 'integer',
          min: 0,
          playerEditable: true,
        },
        { id: 'ac', label: 'AC', type: 'integer', min: 0, default: 10 },
        { id: 'speed', label: 'Speed', type: 'integer', default: 30 },
        { id: 'initiative_bonus', label: 'Initiative bonus', type: 'integer', default: 0 },
        {
          id: 'conditions',
          label: 'Conditions',
          type: 'list<text>',
          playerEditable: true,
          hint: 'prone, poisoned, etc.',
        },
      ],
    },
    {
      id: 'inventory',
      label: 'Inventory',
      fields: [
        { id: 'items', label: 'Items', type: 'list<text>' },
        { id: 'gold', label: 'Gold', type: 'integer', default: 0 },
      ],
    },
  ],
};

const DEFAULT_NPC_SCHEMA: TemplateSchema = {
  version: 1,
  sections: [
    {
      id: 'basics',
      label: 'Basics',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        {
          id: 'tagline',
          label: 'Tagline',
          type: 'text',
          hint: "A short descriptor — 'grizzled innkeeper'",
        },
        { id: 'role', label: 'Role in world', type: 'text' },
        { id: 'race', label: 'Race', type: 'text' },
        { id: 'location', label: 'Where they are', type: 'text' },
      ],
    },
    {
      id: 'combat',
      label: 'Combat (if relevant)',
      fields: [
        { id: 'hp_max', label: 'HP max', type: 'integer' },
        { id: 'hp_current', label: 'HP current', type: 'integer', playerEditable: true },
        { id: 'ac', label: 'AC', type: 'integer' },
        { id: 'cr', label: 'Challenge rating', type: 'text' },
      ],
    },
  ],
};

const DEFAULT_ALLY_SCHEMA: TemplateSchema = {
  version: 1,
  sections: [
    ...DEFAULT_NPC_SCHEMA.sections,
    {
      id: 'relationship',
      label: 'Relationship',
      fields: [
        {
          id: 'disposition',
          label: 'Disposition',
          type: 'enum',
          options: ['friendly', 'warm', 'loyal', 'sworn'],
          default: 'friendly',
        },
        {
          id: 'trust',
          label: 'Trust',
          type: 'integer',
          min: 0,
          max: 10,
          default: 5,
          hint: '0 = wary · 10 = would die for the party',
        },
        { id: 'owes_party', label: 'Party is owed', type: 'longtext' },
        { id: 'owed_to', label: 'Party owes them', type: 'longtext' },
      ],
    },
  ],
};

const DEFAULT_VILLAIN_SCHEMA: TemplateSchema = {
  version: 1,
  sections: [
    ...DEFAULT_NPC_SCHEMA.sections,
    {
      id: 'ambitions',
      label: 'Ambitions & resources',
      fields: [
        { id: 'goal', label: 'Immediate goal', type: 'longtext' },
        { id: 'long_term', label: 'Long-term ambition', type: 'longtext' },
        { id: 'resources', label: 'Resources', type: 'list<text>', hint: 'Allies, artefacts, strongholds' },
        { id: 'weakness', label: 'Known weakness', type: 'longtext' },
      ],
    },
  ],
};

const DEFAULT_SESSION_SCHEMA: TemplateSchema = {
  version: 1,
  sections: [
    {
      id: 'meta',
      label: 'Session info',
      fields: [
        { id: 'date', label: 'Date', type: 'text', required: true, hint: 'YYYY-MM-DD' },
        { id: 'session_number', label: 'Session #', type: 'integer', min: 1 },
        { id: 'title', label: 'Title', type: 'text' },
        { id: 'attendees', label: 'Attendees', type: 'list<text>' },
      ],
    },
    {
      id: 'summary',
      label: 'Summary',
      fields: [
        { id: 'recap', label: 'Recap', type: 'longtext' },
        { id: 'locations', label: 'Locations visited', type: 'list<text>' },
        { id: 'outcomes', label: 'Outcomes / cliffhangers', type: 'longtext' },
      ],
    },
  ],
};

const DEFAULT_ITEM_SCHEMA: TemplateSchema = {
  version: 1,
  sections: [
    {
      id: 'basics',
      label: 'Basics',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          options: ['weapon', 'armor', 'wondrous', 'potion', 'scroll', 'tool', 'treasure', 'other'],
          default: 'wondrous',
        },
        {
          id: 'rarity',
          label: 'Rarity',
          type: 'enum',
          options: ['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'],
          default: 'common',
        },
        { id: 'attunement', label: 'Requires attunement', type: 'boolean', default: false },
      ],
    },
    {
      id: 'stats',
      label: 'Stats',
      fields: [
        { id: 'weight', label: 'Weight (lb)', type: 'number', min: 0 },
        { id: 'value', label: 'Value (gp)', type: 'integer', min: 0 },
        { id: 'charges', label: 'Charges', type: 'integer', min: 0 },
      ],
    },
    {
      id: 'description',
      label: 'Description',
      fields: [
        { id: 'summary', label: 'Summary', type: 'longtext' },
        { id: 'properties', label: 'Properties', type: 'list<text>' },
      ],
    },
  ],
};

const DEFAULT_LOCATION_SCHEMA: TemplateSchema = {
  version: 1,
  sections: [
    {
      id: 'basics',
      label: 'Basics',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          options: ['city', 'town', 'village', 'dungeon', 'wilderness', 'landmark', 'plane', 'other'],
          default: 'town',
        },
        { id: 'region', label: 'Region', type: 'text' },
        { id: 'population', label: 'Population', type: 'text', hint: 'e.g. 12k, mostly dwarves' },
      ],
    },
    {
      id: 'overview',
      label: 'Overview',
      fields: [
        { id: 'summary', label: 'Summary', type: 'longtext' },
        { id: 'notable', label: 'Notable features', type: 'list<text>' },
      ],
    },
  ],
};

const DEFAULT_TEMPLATES: Array<{
  kind: TemplateKind;
  name: string;
  schema: TemplateSchema;
}> = [
  { kind: 'pc', name: 'D&D 5e — Player character', schema: DEFAULT_PC_SCHEMA },
  { kind: 'npc', name: 'NPC', schema: DEFAULT_NPC_SCHEMA },
  { kind: 'ally', name: 'Ally', schema: DEFAULT_ALLY_SCHEMA },
  { kind: 'villain', name: 'Villain', schema: DEFAULT_VILLAIN_SCHEMA },
  { kind: 'session', name: 'Session log', schema: DEFAULT_SESSION_SCHEMA },
  { kind: 'item', name: 'Item', schema: DEFAULT_ITEM_SCHEMA },
  { kind: 'location', name: 'Location', schema: DEFAULT_LOCATION_SCHEMA },
];

/** Populate note_templates on first boot. Idempotent — if a row for
 *  a given kind already exists we leave it alone (so admin edits
 *  aren't overwritten on restart). Run unconditionally at startup. */
export function ensureDefaultTemplates(): void {
  const db = getDb();
  const existingKinds = new Set(
    db
      .query<{ kind: string }, []>('SELECT kind FROM note_templates')
      .all()
      .map((r) => r.kind),
  );
  let inserted = 0;
  for (const tpl of DEFAULT_TEMPLATES) {
    if (existingKinds.has(tpl.kind)) continue;
    upsertTemplate(tpl.kind, tpl.name, tpl.schema, null);
    inserted++;
  }
  if (inserted > 0) {
    console.log(`[templates] seeded ${inserted} default template(s)`);
  }
}
