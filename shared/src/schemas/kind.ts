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

/** Kinds a Wrap-up mention can land on: the Notes a Session adds
 *  History to. Characters get Suggestions instead. */
export const MENTION_KINDS = [
  'person',
  'creature',
  'location',
  'item',
  'quest',
  'lore',
] as const satisfies readonly NoteKind[];
export type MentionKind = (typeof MENTION_KINDS)[number];

export const MENTION_KIND_LABELS = {
  person: 'Person',
  creature: 'Creature',
  location: 'Location',
  item: 'Item',
  quest: 'Quest',
  lore: 'Lore',
} as const satisfies Record<MentionKind, string>;

/** "Person, Creature, Location, Item, Quest or Lore", for prose that
 *  tells a person or a model which Notes a mention may name. */
export function mentionKindList(): string {
  const labels = MENTION_KINDS.map((k) => MENTION_KIND_LABELS[k]);
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
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
