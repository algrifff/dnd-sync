// Race + subrace definitions for the compendium.

import { z } from 'zod';
import { AbilityKey, Senses, Size, Speed } from '../primitives';

export const RacialTrait = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
});

export const AbilityIncrease = z.object({
  ability: AbilityKey,
  amount: z.number().int().min(0).max(10),
});

export const SubraceDef = z.object({
  name: z.string().min(1),
  ability_score_increases: z.array(AbilityIncrease).default([]),
  traits: z.array(RacialTrait).default([]),
});

export const RaceDef = z.object({
  name: z.string().min(1),
  size: Size.default('medium'),
  speed: Speed.default({ walk: 30 }),
  senses: Senses.optional(),
  ability_score_increases: z.array(AbilityIncrease).default([]),
  languages: z.array(z.string()).default([]),
  traits: z.array(RacialTrait).default([]),
  subraces: z.array(SubraceDef).default([]),
});
export type RaceDef = z.infer<typeof RaceDef>;
