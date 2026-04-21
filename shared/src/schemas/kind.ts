// The authoritative list of note kinds. A note's `frontmatter.kind`
// field must be one of these (or absent, for plain notes).
//
// Legacy values — kept so existing notes don't blow up during the
// transition:
//   - 'character' with `role: pc|npc|ally|villain` (old model)
//   - 'monster' (now superseded by 'creature')
//
// New canonical values:
//   - 'character' = player character, full 5e sheet
//   - 'person'    = lightweight NPC (name / location / portrait / notes)
//   - 'creature'  = stat-blocked monster or NPC, with player notes
//   - 'item'      = gear / weapons / wondrous items
//   - 'location'  = places, hierarchical
//   - 'session'   = adventure-log session
//   - 'lore'      = world lore (no sheet)
//   - 'note'      = generic (no sheet)

import { z } from 'zod';

export const NOTE_KINDS = [
  'character',
  'person',
  'creature',
  'item',
  'location',
  'session',
  'lore',
  'note',
  // Legacy:
  'monster',
] as const;

export const NoteKind = z.enum(NOTE_KINDS);
export type NoteKind = z.infer<typeof NoteKind>;

/** Kinds that carry a structured sheet validated by Zod. */
export const SHEETED_KINDS = [
  'character',
  'person',
  'creature',
  'item',
  'location',
] as const;
export type SheetedKind = (typeof SHEETED_KINDS)[number];

export function isSheetedKind(v: unknown): v is SheetedKind {
  return typeof v === 'string' && (SHEETED_KINDS as readonly string[]).includes(v);
}
