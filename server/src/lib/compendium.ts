// Compendium access layer.
//
// The compendium is a cross-world library of canonical TTRPG content
// (classes, feats, spells, items, monsters, …) plus any per-world
// homebrew scoped by group_id. Every entry is JSON validated against
// its Zod schema on write; read APIs do NOT re-validate — that trust
// lives at the seed/upsert boundary.
//
// Ref resolution: a world note can store an entity as `{ compendium_id,
// name, overrides? }`. `resolveRef()` loads the canonical row and
// merges the overrides on top so callers always see the effective,
// per-character shape.

import { randomUUID } from 'node:crypto';
import { getDb } from './db';

export type CompendiumKind =
  | 'class'
  | 'subclass'
  | 'race'
  | 'background'
  | 'feat'
  | 'spell'
  | 'item'
  | 'monster'
  | 'condition';

export type CompendiumEntry<T = unknown> = {
  id: string;
  ruleset: string;
  kind: CompendiumKind;
  name: string;
  slug: string;
  data: T;
  source: string | null;
  groupId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};

type EntryRow = {
  id: string;
  ruleset: string;
  kind: string;
  name: string;
  slug: string;
  data_json: string;
  source: string | null;
  group_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
};

function rowToEntry<T>(r: EntryRow): CompendiumEntry<T> {
  return {
    id: r.id,
    ruleset: r.ruleset,
    kind: r.kind as CompendiumKind,
    name: r.name,
    slug: r.slug,
    data: JSON.parse(r.data_json) as T,
    source: r.source,
    groupId: r.group_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deterministic id so re-seeding is idempotent: ruleset:kind:slug[:group]. */
export function compendiumId(opts: {
  ruleset: string;
  kind: CompendiumKind;
  slug: string;
  groupId?: string | null;
}): string {
  const tail = opts.groupId ? `:${opts.groupId}` : '';
  return `${opts.ruleset}:${opts.kind}:${opts.slug}${tail}`;
}

export function getEntry<T = unknown>(id: string): CompendiumEntry<T> | null {
  const row = getDb()
    .query<EntryRow, [string]>(
      `SELECT id, ruleset, kind, name, slug, data_json, source, group_id,
              version, created_at, updated_at
         FROM compendium_entries WHERE id = ?`,
    )
    .get(id);
  return row ? rowToEntry<T>(row) : null;
}

export function listByKind<T = unknown>(opts: {
  ruleset: string;
  kind: CompendiumKind;
  /** Include homebrew scoped to this group, plus all global entries
   *  (group_id IS NULL). Pass null to see globals only. */
  groupId: string | null;
}): Array<CompendiumEntry<T>> {
  const db = getDb();
  const rows = opts.groupId
    ? db
        .query<EntryRow, [string, string, string]>(
          `SELECT id, ruleset, kind, name, slug, data_json, source, group_id,
                  version, created_at, updated_at
             FROM compendium_entries
            WHERE ruleset = ? AND kind = ?
              AND (group_id IS NULL OR group_id = ?)
            ORDER BY name COLLATE NOCASE`,
        )
        .all(opts.ruleset, opts.kind, opts.groupId)
    : db
        .query<EntryRow, [string, string]>(
          `SELECT id, ruleset, kind, name, slug, data_json, source, group_id,
                  version, created_at, updated_at
             FROM compendium_entries
            WHERE ruleset = ? AND kind = ? AND group_id IS NULL
            ORDER BY name COLLATE NOCASE`,
        )
        .all(opts.ruleset, opts.kind);
  return rows.map(rowToEntry<T>);
}

export function searchByName<T = unknown>(opts: {
  ruleset: string;
  kind?: CompendiumKind;
  query: string;
  groupId: string | null;
  limit?: number;
}): Array<CompendiumEntry<T>> {
  const db = getDb();
  const like = `%${opts.query.trim()}%`;
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const wheres = ['ruleset = ?', 'name LIKE ? COLLATE NOCASE'];
  const args: Array<string | number> = [opts.ruleset, like];
  if (opts.kind) {
    wheres.push('kind = ?');
    args.push(opts.kind);
  }
  if (opts.groupId) {
    wheres.push('(group_id IS NULL OR group_id = ?)');
    args.push(opts.groupId);
  } else {
    wheres.push('group_id IS NULL');
  }
  args.push(limit);
  const rows = db
    .query<EntryRow, Array<string | number>>(
      `SELECT id, ruleset, kind, name, slug, data_json, source, group_id,
              version, created_at, updated_at
         FROM compendium_entries
        WHERE ${wheres.join(' AND ')}
        ORDER BY name COLLATE NOCASE
        LIMIT ?`,
    )
    .all(...args);
  return rows.map(rowToEntry<T>);
}

/** Insert or update a compendium entry. Caller is responsible for
 *  Zod-validating `data` before calling. */
export function upsertEntry(opts: {
  ruleset?: string;
  kind: CompendiumKind;
  name: string;
  slug?: string;
  data: unknown;
  source?: string | null;
  groupId?: string | null;
}): CompendiumEntry {
  const ruleset = opts.ruleset ?? 'dnd5e';
  const slug = opts.slug ?? slugify(opts.name);
  const groupId = opts.groupId ?? null;
  const id = compendiumId({ ruleset, kind: opts.kind, slug, groupId });
  const now = Date.now();
  const db = getDb();
  db.query(
    `INSERT INTO compendium_entries
       (id, ruleset, kind, name, slug, data_json, source, group_id,
        version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       data_json = excluded.data_json,
       source = excluded.source,
       version = compendium_entries.version + 1,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    ruleset,
    opts.kind,
    opts.name,
    slug,
    JSON.stringify(opts.data),
    opts.source ?? null,
    groupId,
    now,
    now,
  );
  const entry = getEntry(id);
  if (!entry) throw new Error(`compendium upsert failed for ${id}`);
  return entry;
}

/** Delete a compendium entry by id. Returns true if a row was removed. */
export function deleteEntry(id: string): boolean {
  const res = getDb()
    .query('DELETE FROM compendium_entries WHERE id = ?')
    .run(id);
  return (res.changes ?? 0) > 0;
}

// ── Ref resolution ─────────────────────────────────────────────────────

export type ResolvedRef<T> = {
  /** Effective data after merging overrides on top of the canonical entry. */
  data: T;
  /** Canonical entry, or null if the ref has no compendium_id or it's gone. */
  entry: CompendiumEntry<T> | null;
  /** True if overrides were applied. */
  hasOverrides: boolean;
};

/** Merge an overrides object shallowly onto a compendium entry. Keys in
 *  `overrides` win; nested objects are replaced wholesale (consumers
 *  wanting fine-grained patching can do a second pass). */
export function resolveRef<T = unknown>(ref: {
  compendium_id?: string | undefined;
  name: string;
  overrides?: Record<string, unknown> | undefined;
}): ResolvedRef<T> {
  const entry = ref.compendium_id ? getEntry<T>(ref.compendium_id) : null;
  const hasOverrides = !!ref.overrides && Object.keys(ref.overrides).length > 0;
  if (!entry) {
    // Freeform ref — only the name survives as the effective data.
    const fallback = { name: ref.name, ...(ref.overrides ?? {}) } as T;
    return { data: fallback, entry: null, hasOverrides };
  }
  const base = entry.data as Record<string, unknown>;
  const merged = hasOverrides ? { ...base, ...ref.overrides } : base;
  return { data: merged as T, entry, hasOverrides };
}

// ── Tiny helper for seed scripts ───────────────────────────────────────

export function newCompendiumUuid(): string {
  return randomUUID();
}
