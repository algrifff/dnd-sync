// Note templates.
//
// A template defines the shape of a structured note's frontmatter for
// a given kind (PC, NPC, Ally, Villain, Session). The schema is edited
// by admins in /settings/templates and lives in the server-global
// `note_templates` table — every world shares one copy because most
// campaigns want the same PC sheet / the same session-log shape.
// Players never see or edit templates; they fill in values via the
// character sheet UI (Phase 1d).
//
// This module owns:
//   * The TypeScript types for the schema (TemplateField, Section, …)
//   * DB CRUD helpers for admins + render layers
//   * ensureDefaultTemplates() — seeds the table on first boot with
//     the minimal PC / NPC / Ally / Villain / Session defaults so
//     there's always something to render against.

import { getDb } from './db';

export type TemplateKind =
  // canonical
  | 'character'
  | 'person'
  | 'creature'
  | 'session'
  | 'item'
  | 'location'
  // legacy kinds kept so existing templates and notes continue to work
  | 'pc'
  | 'npc'
  | 'ally'
  | 'villain'
  | 'monster';

export const TEMPLATE_KINDS: readonly TemplateKind[] = [
  'character',
  'person',
  'creature',
  'session',
  'item',
  'location',
  // legacy
  'pc',
  'npc',
  'ally',
  'villain',
  'monster',
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
  /** Field IDs from this template's sections to surface as a quick
   *  summary line in the note page header (e.g. level, class, type). */
  headerFields?: string[];
  /** How to display the note's portrait image in the page header.
   *  avatar = small circle left of title (characters, NPCs)
   *  hero   = full-width banner below title (locations, monsters)
   *  none   = no image slot */
  imageLayout?: 'avatar' | 'hero' | 'none';
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
  headerFields: ['level', 'class', 'race'],
  imageLayout: 'avatar',
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
  headerFields: ['tagline', 'role', 'race'],
  imageLayout: 'avatar',
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
      label: 'Combat (if known)',
      fields: [
        { id: 'hp_current', label: 'HP (tracked)', type: 'integer', playerEditable: true },
        { id: 'ac', label: 'AC', type: 'integer' },
      ],
    },
  ],
};

const DEFAULT_ALLY_SCHEMA: TemplateSchema = {
  version: 1,
  headerFields: ['tagline', 'role', 'disposition'],
  imageLayout: 'avatar',
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
      ],
    },
  ],
};

const DEFAULT_VILLAIN_SCHEMA: TemplateSchema = {
  version: 1,
  headerFields: ['tagline', 'role'],
  imageLayout: 'avatar',
  sections: [
    ...DEFAULT_NPC_SCHEMA.sections,
  ],
};

const DEFAULT_SESSION_SCHEMA: TemplateSchema = {
  version: 1,
  headerFields: ['date', 'session_number'],
  imageLayout: 'none',
  sections: [
    {
      id: 'meta',
      label: 'Session info',
      fields: [
        { id: 'date', label: 'Date', type: 'text', required: true, hint: 'YYYY-MM-DD' },
        { id: 'session_number', label: 'Session #', type: 'integer', min: 1 },
        { id: 'attendees', label: 'Attendees', type: 'list<text>' },
      ],
    },
  ],
};

const DEFAULT_ITEM_SCHEMA: TemplateSchema = {
  version: 1,
  headerFields: ['type', 'rarity'],
  imageLayout: 'none',
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
        { id: 'charges', label: 'Charges', type: 'integer', min: 0 },
      ],
    },
  ],
};

const DEFAULT_LOCATION_SCHEMA: TemplateSchema = {
  version: 1,
  headerFields: ['type', 'region'],
  imageLayout: 'hero',
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
      ],
    },
  ],
};

const DEFAULT_MONSTER_SCHEMA: TemplateSchema = {
  version: 1,
  headerFields: ['size', 'type', 'ac'],
  imageLayout: 'hero',
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
          options: [
            'aberration', 'beast', 'celestial', 'construct', 'dragon',
            'elemental', 'fey', 'fiend', 'giant', 'humanoid',
            'monstrosity', 'ooze', 'plant', 'undead',
          ],
          default: 'monstrosity',
        },
        {
          id: 'size',
          label: 'Size',
          type: 'enum',
          options: ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'],
          default: 'medium',
        },
      ],
    },
    {
      id: 'combat',
      label: 'Combat (observed)',
      fields: [
        { id: 'ac', label: 'AC', type: 'integer', min: 0 },
        { id: 'hp_current', label: 'HP (tracked)', type: 'integer', min: 0, playerEditable: true },
        { id: 'speed', label: 'Speed', type: 'text', hint: 'e.g. 30 ft., fly 60 ft.' },
        {
          id: 'resistances',
          label: 'Resistances / immunities',
          type: 'list<text>',
          hint: 'what you\'ve discovered',
        },
        {
          id: 'conditions',
          label: 'Conditions',
          type: 'list<text>',
          playerEditable: true,
          hint: 'prone, poisoned, etc.',
        },
      ],
    },
  ],
};

const DEFAULT_PERSON_SCHEMA: TemplateSchema = {
  version: 1,
  headerFields: ['tagline', 'disposition'],
  imageLayout: 'avatar',
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
          hint: "Short descriptor — 'grizzled innkeeper'",
        },
        { id: 'location_path', label: 'Where they are', type: 'text' },
        {
          id: 'disposition',
          label: 'Disposition',
          type: 'enum',
          options: ['friendly', 'neutral', 'hostile', 'unknown'],
          default: 'unknown',
        },
      ],
    },
  ],
};

// `character` / `creature` default to the legacy PC / Monster form
// until the dedicated nested-field UI lands. Validation still happens
// on save; the template only drives the flat form UI.
const DEFAULT_CHARACTER_SCHEMA: TemplateSchema = DEFAULT_PC_SCHEMA;
const DEFAULT_CREATURE_SCHEMA: TemplateSchema = DEFAULT_MONSTER_SCHEMA;

const DEFAULT_TEMPLATES: Array<{
  kind: TemplateKind;
  name: string;
  schema: TemplateSchema;
}> = [
  { kind: 'character', name: 'Character', schema: DEFAULT_CHARACTER_SCHEMA },
  { kind: 'person', name: 'Person (NPC)', schema: DEFAULT_PERSON_SCHEMA },
  { kind: 'creature', name: 'Creature', schema: DEFAULT_CREATURE_SCHEMA },
  { kind: 'session', name: 'Session log', schema: DEFAULT_SESSION_SCHEMA },
  { kind: 'item', name: 'Item', schema: DEFAULT_ITEM_SCHEMA },
  { kind: 'location', name: 'Location', schema: DEFAULT_LOCATION_SCHEMA },
  // legacy — keep so existing notes keep rendering, but won't be offered
  // in the "new entry" menu once UIs reference the canonical kinds.
  { kind: 'pc', name: 'Player character', schema: DEFAULT_PC_SCHEMA },
  { kind: 'npc', name: 'NPC', schema: DEFAULT_NPC_SCHEMA },
  { kind: 'ally', name: 'Ally', schema: DEFAULT_ALLY_SCHEMA },
  { kind: 'villain', name: 'Villain', schema: DEFAULT_VILLAIN_SCHEMA },
  { kind: 'monster', name: 'Monster', schema: DEFAULT_MONSTER_SCHEMA },
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
