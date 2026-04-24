// Canonical monster stat block. Same shape as a world-note creature but
// without the player's personal observations field.

import type { z } from 'zod';
import { CreatureSheet } from '../creature';

export const MonsterDef = CreatureSheet.omit({
  player_notes: true,
  source_ref: true,
});
export type MonsterDef = z.infer<typeof MonsterDef>;
