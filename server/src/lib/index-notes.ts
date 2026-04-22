// Campaign / World-Lore index notes.
//
// Every campaign folder (`Campaigns/<slug>/`) and the top-level
// `World Lore/` folder carries a hidden `index.md`. The sidebar treats
// that file as the folder's "page" — clicking the folder row navigates
// into it — and the graph view uses it as a hub node so campaigns show
// up as radial anchors with their members linking in.
//
// This module owns two jobs:
//   1. `ensureIndexNote()` — write the index.md if it doesn't exist
//      yet. Used by the folder-create route and the import orchestrator.
//   2. `backfillIndexNotes()` — one-shot scan run on server boot so
//      every pre-existing campaign (and World Lore) in every group
//      gets an index page the first time the server starts after this
//      feature lands. Idempotent — subsequent boots are no-ops.

import { getDb } from './db';
import { writeNote, composeMarkdown } from './import-apply';

/** Canonical subfolders every campaign should expose in the sidebar — keep in
 *  sync with `CAMPAIGN_SUBFOLDERS` in import-orchestrate.ts. */
const CAMPAIGN_SUBFOLDERS = [
  'Characters',
  'People',
  'Enemies',
  'Loot',
  'Adventure Log',
  'Places',
  'Creatures',
  'Quests',
] as const;

/** Write `<folderPath>/index.md` with a minimal stub if it doesn't
 *  already exist. Returns true if a new note was created. */
export function ensureIndexNote(
  groupId: string,
  userId: string,
  folderPath: string,
  title: string,
): boolean {
  const db = getDb();
  const path = `${folderPath}/index.md`;
  const existing = db
    .query<{ id: string }, [string, string]>(
      'SELECT id FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path);
  if (existing) return false;

  const fm = { kind: 'note', title };
  try {
    writeNote({
      groupId,
      userId,
      path,
      markdown: composeMarkdown(fm, `# ${title}\n`),
      frontmatter: fm,
      isUpdate: false,
    });
    return true;
  } catch (err) {
    console.warn('[index-notes] failed to write', path, err);
    return false;
  }
}

/** Scan every group and ensure every campaign folder + World Lore has
 *  an index.md. Safe to call on every boot — only writes missing pages. */
export function backfillIndexNotes(): void {
  const db = getDb();

  // Distinct groups referenced by any note, folder marker, or group row.
  const groups = db
    .query<{ id: string }, []>(
      `SELECT id FROM groups
        UNION
       SELECT DISTINCT group_id AS id FROM notes
        UNION
       SELECT DISTINCT group_id AS id FROM folder_markers`,
    )
    .all();

  let created = 0;
  for (const { id: groupId } of groups) {
    // Pick a stable author — the oldest admin in the group, falling back
    // to any member, falling back to any user. We need a real users.id
    // for the updated_by/created_by FK.
    const userRow =
      db
        .query<{ id: string }, [string]>(
          `SELECT u.id FROM users u
             JOIN group_members gm ON gm.user_id = u.id
            WHERE gm.group_id = ? AND gm.role = 'admin'
            ORDER BY u.created_at ASC LIMIT 1`,
        )
        .get(groupId) ??
      db
        .query<{ id: string }, [string]>(
          `SELECT u.id FROM users u
             JOIN group_members gm ON gm.user_id = u.id
            WHERE gm.group_id = ?
            ORDER BY u.created_at ASC LIMIT 1`,
        )
        .get(groupId) ??
      db
        .query<{ id: string }, []>(
          `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`,
        )
        .get();
    if (!userRow) continue;
    const userId = userRow.id;

    // Every campaign folder — whether it already has notes or only a
    // folder marker. Match `Campaigns/<slug>` (one segment under
    // Campaigns, no further nesting).
    const campaignPaths = new Set<string>();
    for (const { path } of db
      .query<{ path: string }, [string]>(
        `SELECT DISTINCT path FROM folder_markers
          WHERE group_id = ? AND path LIKE 'Campaigns/%'`,
      )
      .all(groupId)) {
      const parts = path.split('/');
      if (parts.length >= 2) campaignPaths.add(`Campaigns/${parts[1]}`);
    }
    for (const { path } of db
      .query<{ path: string }, [string]>(
        `SELECT DISTINCT path FROM notes
          WHERE group_id = ? AND path LIKE 'Campaigns/%/%'`,
      )
      .all(groupId)) {
      const parts = path.split('/');
      if (parts.length >= 2) campaignPaths.add(`Campaigns/${parts[1]}`);
    }

    for (const folderPath of campaignPaths) {
      const title = prettifySlug(folderPath.split('/')[1] ?? '');
      if (ensureIndexNote(groupId, userId, folderPath, title)) created++;

      // Backfill canonical subfolder markers so every existing campaign
      // shows the same skeleton in the sidebar as freshly-created ones.
      const now = Date.now();
      for (const sf of CAMPAIGN_SUBFOLDERS) {
        db.query(
          `INSERT OR IGNORE INTO folder_markers (group_id, path, created_at)
           VALUES (?, ?, ?)`,
        ).run(groupId, `${folderPath}/${sf}`, now);
      }
    }

    // World Lore — ensure the marker exists, then the index.
    db.query(
      `INSERT OR IGNORE INTO folder_markers (group_id, path, created_at)
       VALUES (?, 'World Lore', ?)`,
    ).run(groupId, Date.now());
    if (ensureIndexNote(groupId, userId, 'World Lore', 'World Lore')) created++;
  }

  if (created > 0) {
    console.log(`[index-notes] backfilled ${created} index page(s)`);
  }
}

function prettifySlug(slug: string): string {
  if (!slug) return 'Campaign';
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
