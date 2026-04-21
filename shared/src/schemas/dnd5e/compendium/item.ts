// Canonical item definition in the compendium. Reuses ItemSheet minus
// the per-character runtime fields (equipped/attuned/quantity live on
// the inventory entry, not on the canonical item).

import { z } from 'zod';
import { ItemSheet } from '../item';

export const ItemDef = ItemSheet;
export type ItemDef = z.infer<typeof ItemDef>;
