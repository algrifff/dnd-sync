// Class definition used in the compendium (canonical class).

import { z } from 'zod';
import { AbilityKey } from '../primitives';

export const ClassFeature = z.object({
  level: z.number().int().min(1).max(20),
  name: z.string().min(1),
  description: z.string().default(''),
});

export const ClassDef = z.object({
  name: z.string().min(1),
  hit_die: z.union([
    z.literal(6),
    z.literal(8),
    z.literal(10),
    z.literal(12),
  ]),
  primary_ability: z.array(AbilityKey).min(1),
  saving_throw_proficiencies: z.array(AbilityKey).length(2),
  armor_proficiencies: z.array(z.string()).default([]),
  weapon_proficiencies: z.array(z.string()).default([]),
  tool_proficiencies: z.array(z.string()).default([]),
  skill_choices: z.object({
    choose: z.number().int().min(0).default(2),
    from: z.array(z.string()).default([]),
  }),
  spellcasting_ability: AbilityKey.nullable().default(null),
  features: z.array(ClassFeature).default([]),
  subclass_level: z.number().int().min(1).max(20).optional(),
});
export type ClassDef = z.infer<typeof ClassDef>;

export const SubclassDef = z.object({
  name: z.string().min(1),
  parent_class: z.string().min(1),
  features: z.array(ClassFeature).default([]),
});
export type SubclassDef = z.infer<typeof SubclassDef>;
