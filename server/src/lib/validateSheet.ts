// Zod-validation bouncer for structured note sheets.
//
// Every save path that can write frontmatter should call this BEFORE
// persisting so malformed sheets never reach the DB. Validation is
// "forgiving by default": schemas use .passthrough(), so extra keys are
// preserved rather than rejected. Required keys with wrong types DO
// fail — `level: "banana"` is rejected.

import type { z } from 'zod';
import {
  dnd5e,
  isSheetedKind,
  type SheetedKind,
} from '@compendium/shared';

const SCHEMA_BY_KIND: Record<SheetedKind, z.ZodTypeAny> = {
  character: dnd5e.CharacterSheet,
  person: dnd5e.PersonSheet,
  creature: dnd5e.CreatureSheet,
  item: dnd5e.ItemSheet,
  location: dnd5e.LocationSheet,
};

export type ValidateSheetResult =
  | { ok: true; data: unknown }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** Validate a sheet value for a given kind. Returns { ok, data } on
 *  success (data is the parsed/defaulted value) or { ok:false, issues }
 *  on failure. Non-sheeted kinds (lore, note, session, legacy monster)
 *  pass through unchanged. */
export function validateSheet(
  kind: string | undefined,
  sheet: unknown,
): ValidateSheetResult {
  if (!kind || !isSheetedKind(kind)) return { ok: true, data: sheet };
  const schema = SCHEMA_BY_KIND[kind];
  const res = schema.safeParse(sheet ?? {});
  if (res.success) return { ok: true, data: res.data };
  return {
    ok: false,
    issues: res.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}

/** Convenience: validate and throw a typed error on failure. */
export class SheetValidationError extends Error {
  constructor(
    public readonly kind: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(
      `invalid ${kind} sheet: ${issues
        .map((i) => `${i.path || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'SheetValidationError';
  }
}

export function parseSheet<T = unknown>(kind: string, sheet: unknown): T {
  const res = validateSheet(kind, sheet);
  if (!res.ok) throw new SheetValidationError(kind, res.issues);
  return res.data as T;
}
