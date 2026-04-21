// Stat-blocked NPC / monster tracked by a player. `player_notes` is a
// short observed-info memo; the full-length body lives in the TipTap
// note itself.
//
// Mirrors Monster.schema.json from dnd5e_json_schema.

import { z } from 'zod';
import {
  AbilityKey,
  AbilityScores,
  Condition,
  DamageType,
  Dice,
  Ref,
  Senses,
  SkillKey,
  Size,
  Speed,
} from './primitives';

export const MONSTER_TYPES = [
  'aberration',
  'beast',
  'celestial',
  'construct',
  'dragon',
  'elemental',
  'fey',
  'fiend',
  'giant',
  'humanoid',
  'monstrosity',
  'ooze',
  'plant',
  'undead',
  'swarm',
] as const;
export const MonsterType = z.enum(MONSTER_TYPES);
export type MonsterType = z.infer<typeof MonsterType>;

export const CreatureTrait = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
});
export type CreatureTrait = z.infer<typeof CreatureTrait>;

export const CreatureAction = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  attack_bonus: z.number().int().optional(),
  damage_dice: Dice.optional(),
  damage_type: DamageType.optional(),
  /** Legendary / lair / reaction / multiattack — free-form category tag. */
  kind: z.string().optional(),
});
export type CreatureAction = z.infer<typeof CreatureAction>;

export const CreatureSheet = z
  .object({
    // identity
    name: z.string().min(1).optional(),
    size: Size.default('medium'),
    type: MonsterType.default('monstrosity'),
    subtype: z.string().optional(),
    alignment: z.string().optional(),
    portrait: z.string().optional(),
    tags: z.array(z.string()).default([]),

    // link back to compendium monster if this was pulled in
    source_ref: Ref.optional(),

    // core stats
    ability_scores: AbilityScores.default({
      str: 10,
      dex: 10,
      con: 10,
      int: 10,
      wis: 10,
      cha: 10,
    }),
    saving_throws: z
      .record(AbilityKey, z.object({ modifier: z.number().int() }))
      .default({}),
    skills: z
      .record(SkillKey, z.object({ modifier: z.number().int() }))
      .default({}),
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
        formula: z.string().optional(),
      })
      .optional(),
    speed: Speed.default({ walk: 30 }),
    senses: Senses.optional(),
    languages: z.array(z.string()).default([]),
    challenge_rating: z.number().min(0).max(30).default(0),
    proficiency_bonus: z.number().int().min(2).max(9).optional(),

    // defences
    conditions: z.array(Condition).default([]),
    condition_immunities: z.array(Condition).default([]),
    damage_resistances: z.array(DamageType).default([]),
    damage_immunities: z.array(DamageType).default([]),
    damage_vulnerabilities: z.array(DamageType).default([]),

    // abilities
    traits: z.array(CreatureTrait).default([]),
    actions: z.array(CreatureAction).default([]),
    legendary_actions: z.array(CreatureAction).default([]),

    // player's notebook
    player_notes: z.string().optional(),
  })
  .passthrough();

export type CreatureSheet = z.infer<typeof CreatureSheet>;
