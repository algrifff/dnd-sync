#!/usr/bin/env bun
// One-shot audit for paths that violate the invariants enforced by
// `isAllowedPath` in server/src/lib/notes.ts:
//   1. Top-level segment must be one of TOP_LEVEL_ALLOWED
//      (Campaigns / World Lore / Assets).
//   2. No segment may begin with a dot.
//
// Scans the `notes` and `folder_markers` tables and prints offending
// rows grouped by reason, per group_id. Read-only — never mutates.
//
// Usage:
//   bun run scripts/audit-paths.ts               # uses DATA_DIR/compendium.db
//   bun run scripts/audit-paths.ts path/to.db    # explicit DB path

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const TOP_LEVEL_ALLOWED = new Set(['Campaigns', 'World Lore', 'Assets']);

type Row = { group_id: string; path: string };

function classify(path: string): 'ok' | 'foreign_top_level' | 'hidden_segment' {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return 'ok';
  const first = segments[0]!;
  if (!TOP_LEVEL_ALLOWED.has(first)) return 'foreign_top_level';
  for (const seg of segments) {
    if (seg.startsWith('.')) return 'hidden_segment';
  }
  return 'ok';
}

function dbPath(): string {
  const override = process.argv[2];
  if (override) return override;
  const dataDir = process.env.DATA_DIR ?? './server/data';
  return join(dataDir, 'compendium.db');
}

function main(): void {
  const path = dbPath();
  console.log(`[audit-paths] opening ${path}`);
  const db = new Database(path, { readonly: true });

  const notes = db.query<Row, []>(`SELECT group_id, path FROM notes`).all();
  const folders = db
    .query<Row, []>(`SELECT group_id, path FROM folder_markers`)
    .all();

  const byReason: Record<string, Array<{ table: string; row: Row }>> = {
    foreign_top_level: [],
    hidden_segment: [],
  };

  for (const row of notes) {
    const reason = classify(row.path);
    if (reason !== 'ok') byReason[reason]!.push({ table: 'notes', row });
  }
  for (const row of folders) {
    const reason = classify(row.path);
    if (reason !== 'ok') byReason[reason]!.push({ table: 'folder_markers', row });
  }

  const total = byReason.foreign_top_level!.length + byReason.hidden_segment!.length;
  if (total === 0) {
    console.log(`[audit-paths] ✓ clean — ${notes.length} notes, ${folders.length} folders scanned`);
    return;
  }

  console.log(`[audit-paths] ${total} offending row(s):\n`);
  for (const reason of Object.keys(byReason)) {
    const entries = byReason[reason]!;
    if (entries.length === 0) continue;
    console.log(`── ${reason} (${entries.length}) ──────────────────────────`);
    for (const { table, row } of entries) {
      console.log(`  [${table}] group=${row.group_id}  path=${row.path}`);
    }
    console.log('');
  }

  console.log(
    '[audit-paths] Review carefully before mutating — renaming or\n' +
      'deleting these rows is destructive and context-dependent. This\n' +
      'script does not modify the database.',
  );
}

main();
