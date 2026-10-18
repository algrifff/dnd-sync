// The single source of truth for Relationship types: how one Note stands
// to another. Only the forward type is stored; the inverse is read from
// RELATIONS, so the two directions can never disagree. A symmetric type
// is stored once, with its two paths in sorted order. See
// docs/adr/0002-typed-relationships.md.

import { z } from 'zod';

export const RELATION_TYPES = [
  'ally_of',
  'enemy_of',
  'member_of',
  'leads',
  'works_for',
  'owns',
  'located_in',
  'parent_of',
  'related_to',
] as const;

export const RelationType = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof RelationType>;

type RelationInfo = {
  inverse: string;
  symmetric: boolean;
  label: string;
  inverseLabel: string;
};

export const RELATIONS = {
  ally_of: { inverse: 'ally_of', symmetric: true, label: 'ally of', inverseLabel: 'ally of' },
  enemy_of: { inverse: 'enemy_of', symmetric: true, label: 'enemy of', inverseLabel: 'enemy of' },
  member_of: { inverse: 'has_member', symmetric: false, label: 'member of', inverseLabel: 'has member' },
  leads: { inverse: 'led_by', symmetric: false, label: 'leads', inverseLabel: 'led by' },
  works_for: { inverse: 'employs', symmetric: false, label: 'works for', inverseLabel: 'employs' },
  owns: { inverse: 'owned_by', symmetric: false, label: 'owns', inverseLabel: 'owned by' },
  located_in: { inverse: 'contains', symmetric: false, label: 'located in', inverseLabel: 'contains' },
  parent_of: { inverse: 'child_of', symmetric: false, label: 'parent of', inverseLabel: 'child of' },
  related_to: { inverse: 'related_to', symmetric: true, label: 'related to', inverseLabel: 'related to' },
} as const satisfies Record<RelationType, RelationInfo>;

/** A Relationship as read from either end: a stored type or its inverse. */
export type RelationName = RelationType | (typeof RELATIONS)[RelationType]['inverse'];

/** Parses an untrusted relation string, ignoring case and treating spaces
 *  and hyphens as underscores. Null for anything that is not a stored
 *  type, including an inverse such as `has_member`. */
export function parseRelation(raw: unknown): RelationType | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (RELATION_TYPES as readonly string[]).includes(name) ? (name as RelationType) : null;
}

/** Reads a name from one Note's side as the stored form. `swap` is true
 *  when the name is the inverse, so the two ends trade places: `contains`
 *  from A to B is `B located_in A`. Null for an unknown name. A symmetric
 *  type's name is its own inverse and never swaps. */
export function forwardOf(raw: unknown): { relation: RelationType; swap: boolean } | null {
  const type = parseRelation(raw);
  if (type) return { relation: type, swap: false };
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const found = RELATION_TYPES.find((t) => RELATIONS[t].inverse === name);
  return found ? { relation: found, swap: true } : null;
}

export function inverseOf(type: RelationType): RelationName {
  return RELATIONS[type].inverse;
}

/** The stored form of `from type to`: a symmetric type orders its two
 *  paths, so `A ally_of B` and `B ally_of A` are the same row. */
export function canonicalPair(
  from: string,
  type: RelationType,
  to: string,
): { from: string; relation: RelationType; to: string } {
  if (RELATIONS[type].symmetric && to < from) return { from: to, relation: type, to: from };
  return { from, relation: type, to };
}
