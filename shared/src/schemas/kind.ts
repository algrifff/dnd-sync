// The single source of truth for note kinds. A note's `frontmatter.kind`
// is one of NOTE_KINDS (or absent, for plain notes). Older notes and saved
// AI transcripts still carry legacy aliases; KIND_ALIASES collapses them.

import { z } from 'zod';

export const NOTE_KINDS = [
  'character',
  'person',
  'creature',
  'item',
  'location',
  'quest',
  'lore',
  'session',
  'note',
] as const;

export const NoteKind = z.enum(NOTE_KINDS);
export type NoteKind = z.infer<typeof NoteKind>;

export const KIND_ALIASES = {
  pc: 'character',
  npc: 'person',
  ally: 'person',
  villain: 'person',
  monster: 'creature',
} as const satisfies Record<string, NoteKind>;
export type KindAlias = keyof typeof KIND_ALIASES;

/** A canonical kind or a legacy alias. What tool and route inputs accept. */
export type KindInput = NoteKind | KindAlias;
export const KIND_INPUTS = [
  ...NOTE_KINDS,
  ...(Object.keys(KIND_ALIASES) as KindAlias[]),
] as [KindInput, ...KindInput[]];

export function canonicalKind(kind: KindInput): NoteKind {
  return Object.hasOwn(KIND_ALIASES, kind)
    ? KIND_ALIASES[kind as KindAlias]
    : (kind as NoteKind);
}

/** Case-insensitive parse of an untrusted kind string. Null when unknown. */
export function parseKind(raw: unknown): NoteKind | null {
  if (typeof raw !== 'string') return null;
  const kind = raw.toLowerCase();
  if ((KIND_INPUTS as readonly string[]).includes(kind)) {
    return canonicalKind(kind as KindInput);
  }
  return null;
}

/** Kinds that carry a structured sheet validated by Zod. */
export const SHEETED_KINDS = [
  'character',
  'person',
  'creature',
  'item',
  'location',
] as const satisfies readonly NoteKind[];
export type SheetedKind = (typeof SHEETED_KINDS)[number];

export function isSheetedKind(v: unknown): v is SheetedKind {
  return typeof v === 'string' && (SHEETED_KINDS as readonly string[]).includes(v);
}
