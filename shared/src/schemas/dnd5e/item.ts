// Item sheet. Mirrors /schemas/item.schema.json plus weapon.schema.json
// and adds our modifier-based stat effects on top.

import { z } from 'zod';
import { DamageType, Dice, Modifier } from './primitives';

export const ITEM_CATEGORIES = [
  'weapon',
  'armor',
  'shield',
  'equipment',
  'tool',
  'consumable',
  'potion',
  'scroll',
  'wondrous',
  'treasure',
  'ammunition',
  'other',
] as const;
export const ItemCategory = z.enum(ITEM_CATEGORIES);
export type ItemCategory = z.infer<typeof ItemCategory>;

export const RARITIES = [
  'common',
  'uncommon',
  'rare',
  'very rare',
  'legendary',
  'artifact',
] as const;
export const Rarity = z.enum(RARITIES);
export type Rarity = z.infer<typeof Rarity>;

export const WEAPON_PROPERTIES = [
  'ammunition',
  'finesse',
  'heavy',
  'light',
  'loading',
  'monk',
  'reach',
  'silvered',
  'special',
  'thrown',
  'two-handed',
  'versatile',
] as const;
export const WeaponProperty = z.enum(WEAPON_PROPERTIES);
export type WeaponProperty = z.infer<typeof WeaponProperty>;

export const WeaponDetails = z.object({
  category: z.enum(['simple', 'martial', 'improvised']).default('simple'),
  damage: z.object({ dice: Dice, type: DamageType }),
  versatile_damage: z.object({ dice: Dice }).optional(),
  range: z.object({
    normal: z.number().int().min(0).default(5),
    long: z.number().int().min(0).optional(),
  }),
  properties: z.array(WeaponProperty).default([]),
});
export type WeaponDetails = z.infer<typeof WeaponDetails>;

export const ArmorDetails = z.object({
  category: z.enum(['light', 'medium', 'heavy', 'shield']).default('light'),
  ac_base: z.number().int().min(0).default(10),
  dex_cap: z.number().int().min(0).optional(),
  stealth_disadvantage: z.boolean().default(false),
  strength_requirement: z.number().int().min(0).optional(),
});
export type ArmorDetails = z.infer<typeof ArmorDetails>;

export const ItemCharges = z.object({
  max: z.number().int().min(0).default(0),
  current: z.number().int().min(0).default(0),
  recharge: z.string().optional(),
});
export type ItemCharges = z.infer<typeof ItemCharges>;

export const ItemCost = z.object({
  amount: z.number().min(0),
  unit: z.enum(['cp', 'sp', 'ep', 'gp', 'pp']).default('gp'),
});
export type ItemCost = z.infer<typeof ItemCost>;

export const ItemSheet = z
  .object({
    name: z.string().min(1).optional(),
    category: ItemCategory.default('other'),
    rarity: Rarity.default('common'),
    weight: z.number().min(0).default(0),
    cost: ItemCost.optional(),
    description: z.string().optional(),

    requires_attunement: z.boolean().default(false),
    attunement_requirements: z.string().optional(),
    charges: ItemCharges.optional(),

    weapon: WeaponDetails.optional(),
    armor: ArmorDetails.optional(),

    /** Structured stat effects applied while equipped/attuned/always. */
    modifiers: z.array(Modifier).default([]),
    /** Freeform description of effects the structured modifier list
     *  can't capture (story-specific riders, conditional powers, etc.). */
    effects_notes: z.string().optional(),

    tags: z.array(z.string()).default([]),
    portrait: z.string().optional(),
  })
  .passthrough();

export type ItemSheet = z.infer<typeof ItemSheet>;
