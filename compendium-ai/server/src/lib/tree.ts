// Builds a folder tree for the current group's notes. Consumed by the
// /api/tree endpoint + the server-side FileTree render on note pages.

import { getDb } from './db';

/** Default D&D-shaped folder skeleton seeded on first boot. Each
 *  entry is a folder path relative to the vault root; subfolders
 *  must list their full path so the empty-folder marker table
 *  carries them all. Users can delete any folder they don't want;
 *  we only seed on startup when the markers table is empty for the
 *  group, so a second boot doesn't revive deleted folders. */
const DEFAULT_FOLDERS: readonly string[] = [
  'Campaigns',
  'Campaigns/Campaign 1',
  'Campaigns/Campaign 1/PCs',
  'Campaigns/Campaign 1/NPCs',
  'Campaigns/Campaign 1/Allies',
  'Campaigns/Campaign 1/Villains',
  'Campaigns/Campaign 1/Items',
  'Campaigns/Campaign 1/Sessions',
  'Campaigns/Campaign 1/Locations',
  'Lore',
  'Assets',
] as const;

/**
 * Returns true if a folder path is a system-managed folder that
 * should never be deleted or renamed by users. Covers:
 *   - Top-level vault sections (Campaigns, Lore, Assets)
 *   - Per-campaign canonical sub-folders (PCs, NPCs, Allies,
 *     Villains, Items, Sessions, Locations)
 *
 * The check is intentionally path-pattern-based so it works for
 * any campaign slug without needing a DB lookup.
 */
export function isSystemFolder(path: string): boolean {
  if (path === 'Campaigns' || path === 'Lore' || path === 'Assets') return true;
  // Campaigns/<any-slug>  itself is system-managed
  if (/^Campaigns\/[^/]+$/.test(path)) return true;
  // Per-campaign canonical folders
  return /^Campaigns\/[^/]+\/(PCs|NPCs|Allies|Villains|Items|Sessions|Locations)$/.test(path);
}

/** Seed the default folder skeleton if the group has no notes and no
 *  folder_markers yet. Idempotent on a populated vault — runs nothing
 *  if anything already exists so a DM who removed Campaign 1 on a
 *  previous run doesn't see it come back on restart. */
export function ensureDefaultFolders(groupId: string): void {
  const db = getDb();
  const noteCount =
    db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM notes WHERE group_id = ?',
      )
      .get(groupId)?.n ?? 0;
  const folderCount =
    db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM folder_markers WHERE group_id = ?',
      )
      .get(groupId)?.n ?? 0;
  if (noteCount + folderCount > 0) return;

  const now = Date.now();
  const insertFolder = db.query(
    `INSERT OR IGNORE INTO folder_markers (group_id, path, created_at)
     VALUES (?, ?, ?)`,
  );
  const insertCampaign = db.query(
    `INSERT OR IGNORE INTO campaigns (group_id, slug, name, folder_path, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const path of DEFAULT_FOLDERS) insertFolder.run(groupId, path, now);
    // Seed the matching campaigns row so the /characters + /sessions
    // dashboards have something in their dropdown out of the box.
    insertCampaign.run(
      groupId,
      'campaign-1',
      'Campaign 1',
      'Campaigns/Campaign 1',
      now,
    );
  })();

  console.log(
    `[tree] seeded default folder skeleton for group "${groupId}"`,
  );
}

export type TreeFile = {
  kind: 'file';
  name: string;
  path: string;
  title: string;
};

export type TreeDir = {
  kind: 'dir';
  name: string;
  path: string; // folder path without trailing slash
  system: boolean; // true = canonical folder, cannot be deleted or renamed
  children: Array<TreeDir | TreeFile>;
};

export type Tree = {
  root: TreeDir;
  updatedAt: number;
};

export function buildTree(
  groupId: string,
  opts?: { hideDmOnly?: boolean },
): Tree {
  const where = opts?.hideDmOnly
    ? 'WHERE group_id = ? AND dm_only = 0'
    : 'WHERE group_id = ?';
  const rows = getDb()
    .query<
      { path: string; title: string; updated_at: number },
      [string]
    >(
      `SELECT path, title, updated_at FROM notes ${where} ORDER BY path`,
    )
    .all(groupId);

  // Explicit empty-folder markers; rendered alongside folders derived
  // from file paths so user-created organisation survives even when a
  // folder has no notes yet.
  const markers = getDb()
    .query<{ path: string }, [string]>(
      `SELECT path FROM folder_markers WHERE group_id = ? ORDER BY path`,
    )
    .all(groupId);

  const root: TreeDir = { kind: 'dir', name: '', path: '', system: false, children: [] };
  let maxUpdated = 0;

  for (const row of rows) {
    if (row.updated_at > maxUpdated) maxUpdated = row.updated_at;
    insert(root, row.path.split('/'), row.path, row.title);
  }
  for (const { path } of markers) {
    ensureFolder(root, path);
  }

  sortTree(root);
  return { root, updatedAt: maxUpdated };
}

function ensureFolder(root: TreeDir, path: string): void {
  if (!path) return;
  const segments = path.split('/');
  let dir = root;
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i]!;
    const existing = dir.children.find(
      (c): c is TreeDir => c.kind === 'dir' && c.name === name,
    );
    if (existing) {
      dir = existing;
      continue;
    }
    const folderPath = segments.slice(0, i + 1).join('/');
    const child: TreeDir = {
      kind: 'dir',
      name,
      path: folderPath,
      system: isSystemFolder(folderPath),
      children: [],
    };
    dir.children.push(child);
    dir = child;
  }
}

function insert(dir: TreeDir, segments: string[], fullPath: string, title: string): void {
  if (segments.length === 1) {
    const name = segments[0]!;
    dir.children.push({ kind: 'file', name, path: fullPath, title });
    return;
  }
  const head = segments[0]!;
  let child = dir.children.find(
    (c): c is TreeDir => c.kind === 'dir' && c.name === head,
  );
  if (!child) {
    const folderPath = dir.path ? `${dir.path}/${head}` : head;
    child = {
      kind: 'dir',
      name: head,
      path: folderPath,
      system: isSystemFolder(folderPath),
      children: [],
    };
    dir.children.push(child);
  }
  insert(child, segments.slice(1), fullPath, title);
}

function sortTree(dir: TreeDir): void {
  dir.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of dir.children) if (c.kind === 'dir') sortTree(c);
}
