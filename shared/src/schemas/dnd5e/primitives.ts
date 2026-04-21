// D&D 5e shared primitives used across character / creature / item / compendium schemas.
// Sourced from /Users/magig/Desktop/dnd5e_json_schema-master canonical shapes
// and adapted for our JSON-in-frontmatter storage.

import { z } from 'zod';

// ── Ability scores ───────────────────────────────────────────────────────

export const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export const AbilityKey = z.enum(ABILITY_KEYS);
export type AbilityKey = z.infer<typeof AbilityKey>;

export const AbilityScores = z.object({
  str: z.number().int().min(1).max(30).default(10),
  dex: z.number().int().min(1).max(30).default(10),
  con: z.number().int().min(1).max(30).default(10),
  int: z.number().int().min(1).max(30).default(10),
  wis: z.number().int().min(1).max(30).default(10),
  cha: z.number().int().min(1).max(30).default(10),
});
export type AbilityScores = z.infer<typeof AbilityScores>;

// ── Skills (5e canonical 18) ─────────────────────────────────────────────

export const SKILL_KEYS = [
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
export const SkillKey = z.enum(SKILL_KEYS);
export type SkillKey = z.infer<typeof SkillKey>;

/** Which ability each skill is keyed off of (5e canon). */
export const SKILL_ABILITY: Readonly<Record<SkillKey, AbilityKey>> = {
  acrobatics: 'dex',
  animal_handling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleight_of_hand: 'dex',
  stealth: 'dex',
  survival: 'wis',
};

// ── Damage types + conditions ────────────────────────────────────────────

export const DAMAGE_TYPES = [
  'piercing',
  'slashing',
  'bludgeoning',
  'acid',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'poison',
  'psychic',
  'radiant',
  'thunder',
] as const;
export const DamageType = z.enum(DAMAGE_TYPES);
export type DamageType = z.infer<typeof DamageType>;

export const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
] as const;
export const Condition = z.enum(CONDITIONS);
export type Condition = z.infer<typeof Condition>;

// ── Dice / size / speed / senses / currency ──────────────────────────────

export const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;
export const DiceSides = z.union([
  z.literal(4),
  z.literal(6),
  z.literal(8),
  z.literal(10),
  z.literal(12),
  z.literal(20),
  z.literal(100),
]);

export const Dice = z.object({
  count: z.number().int().min(1).max(60).default(1),
  sides: DiceSides.default(6),
  mod: z.number().int().default(0).optional(),
});
export type Dice = z.infer<typeof Dice>;

export const SIZES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'] as const;
export const Size = z.enum(SIZES);
export type Size = z.infer<typeof Size>;

export const Speed = z
  .object({
    walk: z.number().int().min(0).default(30),
    burrow: z.number().int().min(0).optional(),
    climb: z.number().int().min(0).optional(),
    fly: z.number().int().min(0).optional(),
    swim: z.number().int().min(0).optional(),
    hover: z.boolean().optional(),
  })
  .passthrough();
export type Speed = z.infer<typeof Speed>;

export const Senses = z
  .object({
    darkvision: z.number().int().min(0).optional(),
    blindsight: z.number().int().min(0).optional(),
    tremorsense: z.number().int().min(0).optional(),
    truesight: z.number().int().min(0).optional(),
    passive_perception: z.number().int().min(0).optional(),
  })
  .passthrough();
export type Senses = z.infer<typeof Senses>;

export const Currency = z.object({
  pp: z.number().int().min(0).default(0),
  gp: z.number().int().min(0).default(0),
  ep: z.number().int().min(0).default(0),
  sp: z.number().int().min(0).default(0),
  cp: z.number().int().min(0).default(0),
});
export type Currency = z.infer<typeof Currency>;

// ── Modifiers (item / feat effects) ──────────────────────────────────────

/** Full set of targets a modifier can hit. Narrow enum so we can render
 *  a sane UI later — everything resolvable to a numeric bonus or flag on
 *  the character's effective-stats view. */
export const MODIFIER_TARGETS = [
  'ac',
  'hp_max',
  'speed.walk',
  'speed.fly',
  'speed.swim',
  'speed.climb',
  'speed.burrow',
  'initiative',
  'ability.str',
  'ability.dex',
  'ability.con',
  'ability.int',
  'ability.wis',
  'ability.cha',
  'save.str',
  'save.dex',
  'save.con',
  'save.int',
  'save.wis',
  'save.cha',
  'skill.acrobatics',
  'skill.animal_handling',
  'skill.arcana',
  'skill.athletics',
  'skill.deception',
  'skill.history',
  'skill.insight',
  'skill.intimidation',
  'skill.investigation',
  'skill.medicine',
  'skill.nature',
  'skill.perception',
  'skill.performance',
  'skill.persuasion',
  'skill.religion',
  'skill.sleight_of_hand',
  'skill.stealth',
  'skill.survival',
  'attack_bonus',
  'damage_bonus',
  'spell_attack_bonus',
  'spell_save_dc',
  'damage_resist',
  'damage_immune',
  'damage_vuln',
] as const;
export const ModifierTarget = z.enum(MODIFIER_TARGETS);
export type ModifierTarget = z.infer<typeof ModifierTarget>;

export const Modifier = z.object({
  target: ModifierTarget,
  /** '=' sets absolute; '+'/'-' are numeric deltas; advantage/disadvantage
   *  apply to roll-based targets (saves, skills, attacks). */
  op: z.enum(['+', '-', '=', 'advantage', 'disadvantage']),
  value: z.number().optional(),
  /** When this modifier is active. 'equipped' requires the item be
   *  worn/held; 'attuned' requires attunement; 'always' is unconditional
   *  (e.g. feats). */
  when: z.enum(['equipped', 'attuned', 'always']).default('equipped'),
  /** Optional narrative qualifier — e.g. damage type filter for resists. */
  qualifier: z.string().optional(),
  note: z.string().optional(),
});
export type Modifier = z.infer<typeof Modifier>;

// ── Compendium reference ─────────────────────────────────────────────────

/** A pointer from a world note into the global compendium, plus optional
 *  per-owner overrides. If compendium_id is absent, this is a freeform
 *  entry with just a display name — still valid, but not resolvable. */
export const Ref = z.object({
  compendium_id: z.string().optional(),
  name: z.string().min(1),
  /** Field-level overrides merged on top of the canonical data. Opaque
   *  object by design — the consumer decides which keys it will honour. */
  overrides: z.record(z.unknown()).optional(),
});
export type Ref = z.infer<typeof Ref>;

// ── Source citation (mirrors dnd5e Source.schema.json) ───────────────────

export const Source = z
  .object({
    text: z.string().min(1),
    note: z.string().optional(),
    href: z.string().url().optional(),
  })
  .passthrough();
export type Source = z.infer<typeof Source>;
