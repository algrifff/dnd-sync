// Creature index derivation. Populated from BOTH the new `kind: creature`
// and the legacy `kind: monster` so existing notes keep working.

import { getDb } from './db';

type FrontmatterShape = {
  kind?: unknown;
  sheet?: Record<string, unknown>;
  compendium_id?: unknown;
};

export function deriveCreatureFromFrontmatter(opts: {
  groupId: string;
  notePath: string;
  frontmatterJson: string;
}): void {
  const db = getDb();

  let fm: FrontmatterShape;
  try {
    fm = JSON.parse(opts.frontmatterJson) as FrontmatterShape;
  } catch {
    fm = {};
  }

  const isCreatureKind = fm.kind === 'creature' || fm.kind === 'monster';
  if (!isCreatureKind) {
    db.query('DELETE FROM creatures WHERE group_id = ? AND note_path = ?').run(
      opts.groupId,
      opts.notePath,
    );
    return;
  }

  const sheet = (fm.sheet && typeof fm.sheet === 'object' ? fm.sheet : {}) as Record<
    string,
    unknown
  >;

  const name = strOrNull(sheet.name) ?? filenameDisplayName(opts.notePath);
  const type = strOrNull(sheet.type);
  const size = strOrNull(sheet.size);
  const cr = numOrNull(sheet.challenge_rating);
  const ac = intFromSheetAc(sheet.armor_class) ?? intOrNull(sheet.ac);
  const hpMax =
    intFromSheetHp(sheet.hit_points, 'max') ?? intOrNull(sheet.hp_max);
  const compendiumId =
    strOrNull(fm.compendium_id) ??
    strOrNull((sheet as { source_ref?: { compendium_id?: unknown } }).source_ref?.compendium_id);

  db.query(
    `INSERT INTO creatures
       (group_id, note_path, name, type, size, cr, ac, hp_max,
        compendium_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (group_id, note_path) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       size = excluded.size,
       cr = excluded.cr,
       ac = excluded.ac,
       hp_max = excluded.hp_max,
       compendium_id = excluded.compendium_id,
       updated_at = excluded.updated_at`,
  ).run(
    opts.groupId,
    opts.notePath,
    name,
    type,
    size,
    cr,
    ac,
    hpMax,
    compendiumId,
    Date.now(),
  );
}

export type CreatureListRow = {
  notePath: string;
  name: string;
  type: string | null;
  size: string | null;
  cr: number | null;
  ac: number | null;
  hpMax: number | null;
  compendiumId: string | null;
  updatedAt: number;
};

export function listCreatures(groupId: string): CreatureListRow[] {
  return getDb()
    .query<
      {
        note_path: string;
        name: string;
        type: string | null;
        size: string | null;
        cr: number | null;
        ac: number | null;
        hp_max: number | null;
        compendium_id: string | null;
        updated_at: number;
      },
      [string]
    >(
      `SELECT note_path, name, type, size, cr, ac, hp_max, compendium_id, updated_at
         FROM creatures
        WHERE group_id = ?
        ORDER BY name COLLATE NOCASE`,
    )
    .all(groupId)
    .map((r) => ({
      notePath: r.note_path,
      name: r.name,
      type: r.type,
      size: r.size,
      cr: r.cr,
      ac: r.ac,
      hpMax: r.hp_max,
      compendiumId: r.compendium_id,
      updatedAt: r.updated_at,
    }));
}

// ── helpers ────────────────────────────────────────────────────────────

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function intFromSheetAc(v: unknown): number | null {
  if (!v || typeof v !== 'object') return null;
  return intOrNull((v as { value?: unknown }).value);
}

function intFromSheetHp(v: unknown, key: 'max' | 'current'): number | null {
  if (!v || typeof v !== 'object') return null;
  return intOrNull((v as Record<string, unknown>)[key]);
}

function filenameDisplayName(notePath: string): string {
  return (notePath.split('/').pop() ?? notePath).replace(/\.(md|canvas)$/i, '');
}
