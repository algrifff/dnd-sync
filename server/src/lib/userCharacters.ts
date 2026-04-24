// User-level characters: world-independent PCs owned by a user.
//
// Two-way sync with world notes lives in `./userCharacterSync`; this
// module is just the master-record CRUD. All reads/writes scope by
// owner_user_id so one user can never see or patch another's row.
//
// `sheet_json` stores the nested character sheet shape used by the
// SheetHeader editors (hit_points, ability_scores, etc.). Validation
// runs per-kind via `validateSheet()` before writes.

import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { validateSheet } from './validateSheet';

export type UserCharacterKind = 'character' | 'person';

export type UserCharacter = {
  id: string;
  ownerUserId: string;
  name: string;
  kind: UserCharacterKind;
  sheet: Record<string, unknown>;
  portraitUrl: string | null;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string;
  owner_user_id: string;
  name: string;
  kind: string;
  sheet_json: string;
  portrait_url: string | null;
  created_at: number;
  updated_at: number;
};

function rowToUc(row: Row): UserCharacter {
  let sheet: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.sheet_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      sheet = parsed as Record<string, unknown>;
    }
  } catch {
    /* tolerate corrupt JSON — treat as empty */
  }
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    kind: (row.kind === 'person' ? 'person' : 'character') as UserCharacterKind,
    sheet,
    portraitUrl: row.portrait_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateUserCharacterInput = {
  name: string;
  kind?: UserCharacterKind | undefined;
  sheet?: Record<string, unknown> | undefined;
  portraitUrl?: string | null | undefined;
};

export function createUserCharacter(
  ownerUserId: string,
  input: CreateUserCharacterInput,
): UserCharacter {
  const name = input.name.trim();
  if (!name) throw new Error('name required');
  const kind: UserCharacterKind = input.kind ?? 'character';
  const sheet: Record<string, unknown> = { ...(input.sheet ?? {}), name };

  const val = validateSheet(kind, sheet);
  if (!val.ok) {
    const msg = val.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new Error(`invalid_sheet: ${msg}`);
  }

  const id = randomUUID();
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO user_characters
         (id, owner_user_id, name, kind, sheet_json, portrait_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ownerUserId, name, kind, JSON.stringify(val.data ?? sheet), input.portraitUrl ?? null, now, now);

  return {
    id,
    ownerUserId,
    name,
    kind,
    sheet: (val.data as Record<string, unknown>) ?? sheet,
    portraitUrl: input.portraitUrl ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function listUserCharacters(ownerUserId: string): UserCharacter[] {
  const rows = getDb()
    .query<Row, [string]>(
      `SELECT id, owner_user_id, name, kind, sheet_json, portrait_url, created_at, updated_at
       FROM user_characters
       WHERE owner_user_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(ownerUserId);
  return rows.map(rowToUc);
}

export function getUserCharacter(id: string, ownerUserId: string): UserCharacter | null {
  const row = getDb()
    .query<Row, [string, string]>(
      `SELECT id, owner_user_id, name, kind, sheet_json, portrait_url, created_at, updated_at
       FROM user_characters
       WHERE id = ? AND owner_user_id = ?`,
    )
    .get(id, ownerUserId);
  return row ? rowToUc(row) : null;
}

export type UpdateUserCharacterPatch = {
  name?: string | undefined;
  sheet?: Record<string, unknown> | undefined;
  portraitUrl?: string | null | undefined;
};

/** Shallow-merge patch. Nested keys (hit_points, ability_scores) are
 *  replaced wholesale to match the SheetHeader/usePatchSheet contract. */
export function updateUserCharacter(
  id: string,
  ownerUserId: string,
  patch: UpdateUserCharacterPatch,
): UserCharacter | null {
  const current = getUserCharacter(id, ownerUserId);
  if (!current) return null;

  const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!nextName) throw new Error('name cannot be empty');

  const mergedSheet: Record<string, unknown> = patch.sheet
    ? { ...current.sheet, ...patch.sheet, name: nextName }
    : { ...current.sheet, name: nextName };

  const val = validateSheet(current.kind, mergedSheet);
  if (!val.ok) {
    const msg = val.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new Error(`invalid_sheet: ${msg}`);
  }

  const nextPortrait =
    patch.portraitUrl === undefined ? current.portraitUrl : patch.portraitUrl;
  const now = Date.now();

  getDb()
    .query(
      `UPDATE user_characters
         SET name = ?, sheet_json = ?, portrait_url = ?, updated_at = ?
       WHERE id = ? AND owner_user_id = ?`,
    )
    .run(
      nextName,
      JSON.stringify(val.data ?? mergedSheet),
      nextPortrait,
      now,
      id,
      ownerUserId,
    );

  return {
    ...current,
    name: nextName,
    sheet: (val.data as Record<string, unknown>) ?? mergedSheet,
    portraitUrl: nextPortrait,
    updatedAt: now,
  };
}

export function deleteUserCharacter(id: string, ownerUserId: string): boolean {
  const res = getDb()
    .query(`DELETE FROM user_characters WHERE id = ? AND owner_user_id = ?`)
    .run(id, ownerUserId);
  return res.changes > 0;
}
