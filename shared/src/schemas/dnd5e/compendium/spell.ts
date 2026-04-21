import { z } from 'zod';
import { DamageType, Dice } from '../primitives';

export const SPELL_SCHOOLS = [
  'abjuration',
  'conjuration',
  'divination',
  'enchantment',
  'evocation',
  'illusion',
  'necromancy',
  'transmutation',
] as const;
export const SpellSchool = z.enum(SPELL_SCHOOLS);
export type SpellSchool = z.infer<typeof SpellSchool>;

export const SpellDef = z.object({
  name: z.string().min(1),
  /** 0 = cantrip. */
  level: z.number().int().min(0).max(9),
  school: SpellSchool,
  casting_time: z.string().default('1 action'),
  range: z.string().default('Self'),
  components: z.object({
    verbal: z.boolean().default(false),
    somatic: z.boolean().default(false),
    material: z.boolean().default(false),
    material_description: z.string().optional(),
    material_cost_gp: z.number().min(0).optional(),
    consumed: z.boolean().default(false),
  }),
  duration: z.string().default('Instantaneous'),
  ritual: z.boolean().default(false),
  concentration: z.boolean().default(false),
  classes: z.array(z.string()).default([]),
  description: z.string().default(''),
  higher_level: z.string().optional(),
  damage: z
    .object({
      dice: Dice,
      type: DamageType,
    })
    .optional(),
  save: z
    .object({
      ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']),
      on_success: z.enum(['none', 'half']).default('none'),
    })
    .optional(),
  attack: z.enum(['melee', 'ranged']).optional(),
});
export type SpellDef = z.infer<typeof SpellDef>;
