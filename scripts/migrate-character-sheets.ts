#!/usr/bin/env bun
// One-shot backfill of legacy character / NPC / monster / item / location
// notes onto the new Zod-validated sheet shape.
//
// What it does, per note:
//   * kind:character (legacy role=pc|npc|ally|villain) →
//       - pc      → kind:character (keep), fill canonical sheet shape
//       - npc/ally/villain → kind:person, collapse legacy combat fields
//   * kind:monster → kind:creature (copy across ac/hp/size/type)
//   * kind:item    → pull `type`→`category`, `attunement`→`requires_attunement`
//   * kind:location → already flat; only rename `type` if absent
//
// Skips any note whose sheet already has `ability_scores` or `armor_class`
// (markers of the new shape) so re-running is a no-op.
//
// Usage:
//   bun run scripts/migrate-character-sheets.ts [--apply]
//
// Without --apply the script prints intended changes without writing.

import { getDb } from '../server/src/lib/db';
import { deriveAllIndexes } from '../server/src/lib/derive-indexes';

type NoteRow = {
  group_id: string;
  path: string;
  frontmatter_json: string;
};

type Sheet = Record<string, unknown>;
type Fm = {
  kind?: unknown;
  role?: unknown;
  sheet?: unknown;
  [k: string]: unknown;
};

const APPLY = process.argv.includes('--apply');

function readSheet(fm: Fm): Sheet {
  if (fm.sheet && typeof fm.sheet === 'object') {
    return { ...(fm.sheet as Sheet) };
  }
  return {};
}

function alreadyNewShape(sheet: Sheet): boolean {
  return 'ability_scores' in sheet || 'armor_class' in sheet;
}

type Migration = {
  nextFm: Fm;
  notes: string[];
};

function migrateCharacterLike(fm: Fm): Migration | null {
  const sheet = readSheet(fm);
  if (alreadyNewShape(sheet)) return null;

  const role =
    typeof fm.role === 'string'
      ? fm.role.toLowerCase()
      : typeof sheet.role === 'string'
        ? (sheet.role as string).toLowerCase()
        : 'pc';

  const notes: string[] = [];
  const name = (sheet.name as string | undefined) ?? undefined;
  const level = Number(sheet.level);
  const className = (sheet.class as string | undefined) ?? undefined;
  const raceName = (sheet.race as string | undefined) ?? undefined;
  const hpMax = Number(sheet.hp_max);
  const hpCurrent = Number(sheet.hp_current);
  const ac = Number(sheet.ac);

  if (role === 'pc') {
    const next: Sheet = { ...sheet };
    if (name) next.name = name;
    if (Number.isFinite(level) && level > 0 && className) {
      next.classes = [
        { ref: { name: className }, level, hit_dice_used: 0 },
      ];
      delete next.class;
      delete next.level;
      notes.push(`pc → classes=[${className} L${level}]`);
    }
    if (raceName) {
      next.race = { ref: { name: raceName } };
      notes.push(`race "${raceName}" → ref`);
    }
    if (Number.isFinite(hpMax) || Number.isFinite(hpCurrent)) {
      next.hit_points = {
        max: Number.isFinite(hpMax) ? hpMax : 0,
        current: Number.isFinite(hpCurrent) ? hpCurrent : 0,
        temporary: 0,
      };
      delete next.hp_max;
      delete next.hp_current;
      notes.push('hp_* → hit_points');
    }
    if (Number.isFinite(ac)) {
      next.armor_class = { value: ac };
      delete next.ac;
      notes.push('ac → armor_class.value');
    }
    if (!next.ability_scores) {
      next.ability_scores = {
        str: Number(sheet.str) || 10,
        dex: Number(sheet.dex) || 10,
        con: Number(sheet.con) || 10,
        int: Number(sheet.int) || 10,
        wis: Number(sheet.wis) || 10,
        cha: Number(sheet.cha) || 10,
      };
      for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
        delete next[k];
      }
      notes.push('abilities → ability_scores');
    }

    const nextFm: Fm = { ...fm, kind: 'character', sheet: next };
    delete nextFm.role;
    return { nextFm, notes };
  }

  // npc / ally / villain → kind:person
  const next: Sheet = {};
  if (name) next.name = name;
  if (typeof sheet.tagline === 'string') next.tagline = sheet.tagline;
  if (typeof sheet.location === 'string') next.location_path = sheet.location;
  if (role === 'villain') next.disposition = 'hostile';
  else if (role === 'ally') next.disposition = 'friendly';
  else next.disposition = 'unknown';
  const tags = Array.isArray(sheet.tags) ? (sheet.tags as string[]) : [];
  next.tags = tags;

  const nextFm: Fm = { ...fm, kind: 'person', sheet: next };
  delete nextFm.role;
  notes.push(`role ${role} → kind:person`);
  return { nextFm, notes };
}

function migrateMonster(fm: Fm): Migration | null {
  const sheet = readSheet(fm);
  if (alreadyNewShape(sheet)) return null;

  const notes: string[] = [];
  const next: Sheet = { ...sheet };
  const hpCur = Number(sheet.hp_current);
  const hpMax = Number(sheet.hp_max);
  const ac = Number(sheet.ac);
  if (Number.isFinite(hpCur) || Number.isFinite(hpMax)) {
    next.hit_points = {
      max: Number.isFinite(hpMax) ? hpMax : Number.isFinite(hpCur) ? hpCur : 0,
      current: Number.isFinite(hpCur) ? hpCur : 0,
      temporary: 0,
    };
    delete next.hp_max;
    delete next.hp_current;
    notes.push('hp_* → hit_points');
  }
  if (Number.isFinite(ac)) {
    next.armor_class = { value: ac };
    delete next.ac;
    notes.push('ac → armor_class.value');
  }

  const nextFm: Fm = { ...fm, kind: 'creature', sheet: next };
  notes.push('kind:monster → kind:creature');
  return { nextFm, notes };
}

function migrateItem(fm: Fm): Migration | null {
  const sheet = readSheet(fm);
  if ('category' in sheet) return null;
  const next: Sheet = { ...sheet };
  const notes: string[] = [];
  if (typeof sheet.type === 'string') {
    next.category = sheet.type;
    delete next.type;
    notes.push(`type "${sheet.type}" → category`);
  }
  if (sheet.attunement !== undefined) {
    next.requires_attunement = Boolean(sheet.attunement);
    delete next.attunement;
    notes.push('attunement → requires_attunement');
  }
  if (notes.length === 0) return null;
  return { nextFm: { ...fm, sheet: next }, notes };
}

async function main(): Promise<void> {
  const db = getDb();
  const rows = db
    .query<NoteRow, []>(
      'SELECT group_id, path, frontmatter_json FROM notes',
    )
    .all();

  const counters = { inspected: 0, changed: 0, skipped: 0 };
  for (const row of rows) {
    counters.inspected++;
    let fm: Fm;
    try {
      fm = JSON.parse(row.frontmatter_json || '{}') as Fm;
    } catch {
      continue;
    }
    const kind = typeof fm.kind === 'string' ? fm.kind : '';

    let mig: Migration | null = null;
    if (kind === 'character' || kind === 'pc' || kind === 'npc' ||
        kind === 'ally' || kind === 'villain') {
      mig = migrateCharacterLike(fm);
    } else if (kind === 'monster') {
      mig = migrateMonster(fm);
    } else if (kind === 'item') {
      mig = migrateItem(fm);
    }

    if (!mig) { counters.skipped++; continue; }
    counters.changed++;
    console.log(`[${APPLY ? 'APPLY' : 'DRY'}] ${row.group_id}:${row.path}`);
    for (const n of mig.notes) console.log(`    - ${n}`);

    if (APPLY) {
      const nextJson = JSON.stringify(mig.nextFm);
      db.query(
        'UPDATE notes SET frontmatter_json=?, updated_at=? WHERE group_id=? AND path=?',
      ).run(nextJson, Date.now(), row.group_id, row.path);
      deriveAllIndexes({
        groupId: row.group_id,
        notePath: row.path,
        frontmatterJson: nextJson,
      });
    }
  }

  console.log('');
  console.log(
    `${APPLY ? 'Applied' : 'Dry-run'}: inspected=${counters.inspected} changed=${counters.changed} skipped=${counters.skipped}`,
  );
  if (!APPLY) console.log('Re-run with --apply to write changes.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
