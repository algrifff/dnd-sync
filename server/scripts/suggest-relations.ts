// Prints CANDIDATE Relationships from the frontmatter of Person and
// Creature Notes: `faction: X` suggests `<note> member_of X`, and
// `location: X` suggests `<note> located_in X`. X is resolved to a Note in
// the same world by title, then alias.
//
// READ-ONLY. The database is opened read-only and nothing is written, and
// nothing calls addRelation. Turning a candidate into a Relationship goes
// through a reviewed Wrap-up (docs/adr/0002-typed-relationships.md), never
// directly. This is an operator tool with direct DB access, so it reads
// hidden Notes too and marks a candidate [gm_only] / [dm_only] when either
// end is hidden.
//
// Usage: bun scripts/suggest-relations.ts [--db <path>] [--group <name-or-id>] [--json]

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatSuggestions, suggestRelations } from '../src/lib/relation-suggestions';

const HELP = `Suggest Relationships from the faction and location fields of Person and Creature Notes.

Usage: bun scripts/suggest-relations.ts [options]

  --db <path>            SQLite file (default: $DATA_DIR/compendium.db, else ./.data/compendium.db)
  --group <name-or-id>   only this world
  --json                 machine-readable output
  -h, --help             this text

Read-only: it opens the database read-only and writes nothing. Candidates are
not Relationships. They become Relationships only when a Wrap-up proposes them
and a Player reviews it (docs/adr/0002-typed-relationships.md).
`;

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' },
      group: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const dbPath = resolve(values.db ?? join(process.env.DATA_DIR ?? './.data', 'compendium.db'));
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);

  const db = new Database(dbPath, { readonly: true });
  try {
    const worlds = suggestRelations(db, { group: values.group });
    console.log(values.json ? JSON.stringify(worlds, null, 2) : formatSuggestions(worlds));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`suggest-relations: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
