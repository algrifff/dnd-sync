// JSON Schema (strict mode) we hand to OpenAI for character extraction,
// plus the matching TypeScript shape.
//
// Strict mode rules: every property listed must be in `required`, and
// `additionalProperties: false`. There are no real "optional" fields —
// we use nullable types and let downstream code drop nulls before merge.
//
// Schema is deliberately FLAT (no nested ability_scores, hit_points
// objects). The shape that lands in `frontmatter.sheet` is nested per
// CharacterSheet, but flattening here makes the LLM job easier and more
// reliable. `transform.ts` reshapes flat → nested.

export type ExtractedCharacter = {
  name: string;
  player: string | null;
  alignment: string | null;
  xp: number;
  race: string | null;
  background: string | null;
  classes: Array<{ name: string; level: number; subclass: string | null }>;

  ability_scores: {
    str: number;
    dex: number;
    con: number;
    int: number;
    wis: number;
    cha: number;
  };
  saving_throw_proficiencies: Array<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'>;
  skill_proficiencies: Array<{
    skill: SkillKey;
    expertise: boolean;
  }>;

  proficiency_bonus: number;
  armor_class: number | null;
  initiative_bonus: number;
  speed_walk: number | null;
  passive_perception: number | null;
  darkvision: number | null;

  hit_points_max: number | null;
  hit_points_current: number | null;
  hit_points_temp: number;
  hit_dice: string | null;

  languages: string[];
  weapon_proficiencies: string[];
  armor_proficiencies: string[];
  tool_proficiencies: string[];

  spellcasting_ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha' | null;
  spell_save_dc: number | null;
  spell_attack_bonus: number | null;
  spell_slots: Array<{ level: number; max: number }>;

  inventory: Array<{
    name: string;
    quantity: number;
    equipped: boolean;
    attuned: boolean;
  }>;
  currency: {
    pp: number;
    gp: number;
    ep: number;
    sp: number;
    cp: number;
  };

  details: {
    age: string | null;
    height: string | null;
    weight: string | null;
    eyes: string | null;
    hair: string | null;
    skin: string | null;
    appearance: string;
    backstory: string;
    personality: string;
    ideal: string;
    bond: string;
    flaw: string;
  };

  features_md: string;
  notes_md: string;
};

const SKILL_KEYS = [
  'acrobatics',
  'animal_handling',
  'arcana',
  'athletics',
  'deception',
  'history',
  'insight',
  'intimidation',
  'investigation',
  'medicine',
  'nature',
  'perception',
  'performance',
  'persuasion',
  'religion',
  'sleight_of_hand',
  'stealth',
  'survival',
] as const;
export type SkillKey = (typeof SKILL_KEYS)[number];
export const SKILL_KEYS_LIST: readonly SkillKey[] = SKILL_KEYS;

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

/** Build a JSON Schema object with `additionalProperties: false` and an
 *  auto-populated `required` listing every property. */
function obj(
  properties: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
    ...(extra ?? {}),
  };
}

const nullableString = { type: ['string', 'null'] };
const nullableInt = { type: ['integer', 'null'] };

export const EXTRACTED_CHARACTER_SCHEMA: Record<string, unknown> = obj({
  name: { type: 'string' },
  player: nullableString,
  alignment: nullableString,
  xp: { type: 'integer', minimum: 0 },
  race: nullableString,
  background: nullableString,
  classes: {
    type: 'array',
    items: obj({
      name: { type: 'string' },
      level: { type: 'integer', minimum: 1, maximum: 20 },
      subclass: nullableString,
    }),
  },

  ability_scores: obj({
    str: { type: 'integer' },
    dex: { type: 'integer' },
    con: { type: 'integer' },
    int: { type: 'integer' },
    wis: { type: 'integer' },
    cha: { type: 'integer' },
  }),
  saving_throw_proficiencies: {
    type: 'array',
    items: { type: 'string', enum: [...ABILITY_KEYS] },
  },
  skill_proficiencies: {
    type: 'array',
    items: obj({
      skill: { type: 'string', enum: [...SKILL_KEYS] },
      expertise: { type: 'boolean' },
    }),
  },

  proficiency_bonus: { type: 'integer' },
  armor_class: nullableInt,
  initiative_bonus: { type: 'integer' },
  speed_walk: nullableInt,
  passive_perception: nullableInt,
  darkvision: nullableInt,

  hit_points_max: nullableInt,
  hit_points_current: nullableInt,
  hit_points_temp: { type: 'integer' },
  hit_dice: nullableString,

  languages: { type: 'array', items: { type: 'string' } },
  weapon_proficiencies: { type: 'array', items: { type: 'string' } },
  armor_proficiencies: { type: 'array', items: { type: 'string' } },
  tool_proficiencies: { type: 'array', items: { type: 'string' } },

  spellcasting_ability: { type: ['string', 'null'], enum: [...ABILITY_KEYS, null] },
  spell_save_dc: nullableInt,
  spell_attack_bonus: nullableInt,
  spell_slots: {
    type: 'array',
    items: obj({
      level: { type: 'integer', minimum: 1, maximum: 9 },
      max: { type: 'integer', minimum: 0 },
    }),
  },

  inventory: {
    type: 'array',
    items: obj({
      name: { type: 'string' },
      quantity: { type: 'integer', minimum: 1 },
      equipped: { type: 'boolean' },
      attuned: { type: 'boolean' },
    }),
  },
  currency: obj({
    pp: { type: 'integer', minimum: 0 },
    gp: { type: 'integer', minimum: 0 },
    ep: { type: 'integer', minimum: 0 },
    sp: { type: 'integer', minimum: 0 },
    cp: { type: 'integer', minimum: 0 },
  }),

  details: obj({
    age: nullableString,
    height: nullableString,
    weight: nullableString,
    eyes: nullableString,
    hair: nullableString,
    skin: nullableString,
    appearance: { type: 'string' },
    backstory: { type: 'string' },
    personality: { type: 'string' },
    ideal: { type: 'string' },
    bond: { type: 'string' },
    flaw: { type: 'string' },
  }),

  features_md: { type: 'string' },
  notes_md: { type: 'string' },
});
