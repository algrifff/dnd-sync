// Item index derivation. A note with frontmatter `kind: item` gets a
// row in `items` so we can answer "all weapons in this world" without
// scanning every note JSON. Idempotent; clears the row if the kind
// changes off `item`.

import { getDb } from './db';

type FrontmatterShape = {
  kind?: unknown;
  sheet?: Record<string, unknown>;
  compendium_id?: unknown;
};

export function deriveItemFromFrontmatter(opts: {
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

  if (fm.kind !== 'item') {
    db.query('DELETE FROM items WHERE group_id = ? AND note_path = ?').run(
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
  const category = strOrNull(sheet.category) ?? strOrNull(sheet.type); // legacy 'type'
  const rarity = strOrNull(sheet.rarity);
  const attunement = boolVal(sheet.requires_attunement) ?? boolVal(sheet.attunement) ?? false;
  const weight = numOrNull(sheet.weight);
  const costGp = deriveCostGp(sheet.cost);
  const compendiumId = strOrNull(fm.compendium_id) ?? strOrNull((sheet as { compendium_id?: unknown }).compendium_id);

  db.query(
    `INSERT INTO items
       (group_id, note_path, name, category, rarity, attunement,
        weight, cost_gp, compendium_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (group_id, note_path) DO UPDATE SET
       name = excluded.name,
       category = excluded.category,
       rarity = excluded.rarity,
       attunement = excluded.attunement,
       weight = excluded.weight,
       cost_gp = excluded.cost_gp,
       compendium_id = excluded.compendium_id,
       updated_at = excluded.updated_at`,
  ).run(
    opts.groupId,
    opts.notePath,
    name,
    category,
    rarity,
    attunement ? 1 : 0,
    weight,
    costGp,
    compendiumId,
    Date.now(),
  );
}

export type ItemListRow = {
  notePath: string;
  name: string;
  category: string | null;
  rarity: string | null;
  attunement: boolean;
  weight: number | null;
  costGp: number | null;
  compendiumId: string | null;
  updatedAt: number;
};

export function listItems(
  groupId: string,
  filter?: { category?: string },
): ItemListRow[] {
  const db = getDb();
  const wheres = ['group_id = ?'];
  const args: string[] = [groupId];
  if (filter?.category) {
    wheres.push('category = ?');
    args.push(filter.category);
  }
  return db
    .query<
      {
        note_path: string;
        name: string;
        category: string | null;
        rarity: string | null;
        attunement: number;
        weight: number | null;
        cost_gp: number | null;
        compendium_id: string | null;
        updated_at: number;
      },
      string[]
    >(
      `SELECT note_path, name, category, rarity, attunement,
              weight, cost_gp, compendium_id, updated_at
         FROM items
        WHERE ${wheres.join(' AND ')}
        ORDER BY name COLLATE NOCASE`,
    )
    .all(...args)
    .map((r) => ({
      notePath: r.note_path,
      name: r.name,
      category: r.category,
      rarity: r.rarity,
      attunement: !!r.attunement,
      weight: r.weight,
      costGp: r.cost_gp,
      compendiumId: r.compendium_id,
      updatedAt: r.updated_at,
    }));
}

// ── helpers ────────────────────────────────────────────────────────────

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function boolVal(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
  }
  return null;
}

function filenameDisplayName(notePath: string): string {
  return (notePath.split('/').pop() ?? notePath).replace(/\.(md|canvas)$/i, '');
}

/** Convert a cost object {amount, unit} to gold-piece equivalent. Null
 *  if the shape isn't recognisable. */
function deriveCostGp(v: unknown): number | null {
  if (!v || typeof v !== 'object') return null;
  const cost = v as { amount?: unknown; unit?: unknown };
  const amount = numOrNull(cost.amount);
  if (amount === null) return null;
  const unit = typeof cost.unit === 'string' ? cost.unit.toLowerCase() : 'gp';
  switch (unit) {
    case 'cp': return amount / 100;
    case 'sp': return amount / 10;
    case 'ep': return amount / 2;
    case 'gp': return amount;
    case 'pp': return amount * 10;
    default:   return null;
  }
}
