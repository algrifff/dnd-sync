// Full 5e player-character sheet. Lives under `note.frontmatter.sheet`
// when `note.frontmatter.kind === 'character'`.
//
// Mirrors /Users/magig/Desktop/dnd5e_json_schema-master/schemas/Character.schema.json
// adapted for our storage (nested compendium refs + player-POV extras).

import { z } from 'zod';
import {
  AbilityScores,
  Condition,
  Currency,
  DamageType,
  AbilityKey,
  Ref,
  SkillKey,
  Speed,
  Senses,
} from './primitives';

/** A single class in a character's (possibly multi-)class array. */
export const CharacterClass = z.object({
  ref: Ref,
  level: z.number().int().min(1).max(20),
  subclass: z.string().optional(),
  /** Hit dice already spent this long rest, count only. */
  hit_dice_used: z.number().int().min(0).default(0),
});
export type CharacterClass = z.infer<typeof CharacterClass>;

export const SkillEntry = z.object({
  proficient: z.boolean().default(false),
  expertise: z.boolean().default(false),
});
export type SkillEntry = z.infer<typeof SkillEntry>;

export const SavingThrowEntry = z.object({
  proficient: z.boolean().default(false),
});
export type SavingThrowEntry = z.infer<typeof SavingThrowEntry>;

export const DeathSaves = z.object({
  successes: z.number().int().min(0).max(3).default(0),
  failures: z.number().int().min(0).max(3).default(0),
});
export type DeathSaves = z.infer<typeof DeathSaves>;

export const SpellSlotLevel = z.object({
  max: z.number().int().min(0).default(0),
  used: z.number().int().min(0).default(0),
});

export const Spellcasting = z.object({
  ability: AbilityKey,
  spell_save_dc: z.number().int().default(0),
  spell_attack_bonus: z.number().int().default(0),
  slots: z
    .object({
      '1': SpellSlotLevel.optional(),
      '2': SpellSlotLevel.optional(),
      '3': SpellSlotLevel.optional(),
      '4': SpellSlotLevel.optional(),
      '5': SpellSlotLevel.optional(),
      '6': SpellSlotLevel.optional(),
      '7': SpellSlotLevel.optional(),
      '8': SpellSlotLevel.optional(),
      '9': SpellSlotLevel.optional(),
    })
    .partial(),
});
export type Spellcasting = z.infer<typeof Spellcasting>;

export const KnownSpell = z.object({
  ref: Ref,
  /** Spell level at which this character knows it (0 = cantrip). */
  level: z.number().int().min(0).max(9),
  prepared: z.boolean().default(false),
  always_prepared: z.boolean().default(false),
});
export type KnownSpell = z.infer<typeof KnownSpell>;

export const InventoryEntry = z.object({
  ref: Ref,
  quantity: z.number().int().min(1).default(1),
  equipped: z.boolean().default(false),
  attuned: z.boolean().default(false),
  /** Per-character tweaks to the canonical item (renaming, extra notes,
   *  different charges, etc.). Merged over the compendium item at render. */
  overrides: z.record(z.unknown()).optional(),
});
export type InventoryEntry = z.infer<typeof InventoryEntry>;

export const CharacterDetails = z
  .object({
    age: z.string().optional(),
    eyes: z.string().optional(),
    hair: z.string().optional(),
    skin: z.string().optional(),
    height: z.string().optional(),
    weight: z.string().optional(),
    personality: z.string().optional(),
    ideal: z.string().optional(),
    bond: z.string().optional(),
    flaw: z.string().optional(),
    backstory: z.string().optional(),
  })
  .passthrough();

// NOTE: forgiving during Phase 1 rollout — most top-level fields are
// optional so legacy flat-shape sheets (pre-migration) pass through
// untouched. The migration script backfills the canonical shape; a
// later tightening pass makes the load-bearing fields required.
export const CharacterSheet = z
  .object({
    // identity
    name: z.string().min(1).optional(),
    player: z.string().optional(),
    nickname: z.string().optional(),
    portrait: z.string().optional(),
    xp: z.number().int().min(0).default(0),
    inspiration: z.boolean().default(false),
    alignment: z.string().optional(),

    // origins
    //
    // Legacy character notes stored these as a plain display string
    // ("Half-Elf", "Sage"). Accept either that scalar shape or the
    // new nested-ref shape, and coerce legacy strings up to the new
    // shape on read so consumers only ever see `{ ref: { name } }`.
    race: z
      .union([
        z
          .string()
          .min(1)
          .transform((name) => ({ ref: { name } })),
        z.object({ ref: Ref, subrace: z.string().optional() }),
      ])
      .optional(),
    background: z
      .union([
        z
          .string()
          .min(1)
          .transform((name) => ({ ref: { name } })),
        z.object({ ref: Ref, variant: z.string().optional() }),
      ])
      .optional(),

    // classes (supports multiclass)
    classes: z.array(CharacterClass).default([]),

    // core stats
    ability_scores: AbilityScores.optional(),
    saving_throws: z.record(AbilityKey, SavingThrowEntry).default({}),
    skills: z.record(SkillKey, SkillEntry).default({}),
    proficiency_bonus: z.number().int().min(2).max(6).default(2),
    armor_class: z
      .object({
        value: z.number().int().min(0).default(10),
        description: z.string().optional(),
      })
      .optional(),
    hit_points: z
      .object({
        max: z.number().int().min(0).default(0),
        current: z.number().int().min(-9999).default(0),
        temporary: z.number().int().min(0).default(0),
      })
      .optional(),
    // Legacy character notes stored speed as a plain integer (e.g.
    // 30). Accept either that scalar or the new Speed object, and
    // coerce the scalar up to `{ walk: n }` so downstream code only
    // has one shape to worry about.
    speed: z
      .union([
        z
          .number()
          .int()
          .min(0)
          .transform((walk) => ({ walk })),
        Speed,
      ])
      .optional(),
    senses: Senses.optional(),
    initiative_bonus: z.number().int().default(0),
    death_saves: DeathSaves.default({ successes: 0, failures: 0 }),

    // proficiencies
    weapon_proficiencies: z.array(z.string()).default([]),
    armor_proficiencies: z.array(z.string()).default([]),
    tool_proficiencies: z.array(z.string()).default([]),
    languages: z.array(z.string()).default([]),

    // abilities
    feats: z.array(z.object({ ref: Ref })).default([]),
    spellcasting: Spellcasting.optional(),
    spells: z.array(KnownSpell).default([]),

    // inventory
    inventory: z.array(InventoryEntry).default([]),
    currency: Currency.default({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }),

    // defences & state
    conditions: z.array(Condition).default([]),
    condition_immunities: z.array(Condition).default([]),
    damage_resistances: z.array(DamageType).default([]),
    damage_immunities: z.array(DamageType).default([]),
    damage_vulnerabilities: z.array(DamageType).default([]),

    // roleplay
    details: CharacterDetails.default({}),
  })
  .passthrough();

export type CharacterSheet = z.infer<typeof CharacterSheet>;
