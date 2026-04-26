// Builds a folder tree for the current group's notes. Consumed by the
// /api/tree endpoint + the server-side FileTree render on note pages.

import { getDb } from './db';

/** Default campaign-shaped folder skeleton seeded on first boot. Each
 *  entry is a folder path relative to the vault root; subfolders
 *  must list their full path so the empty-folder marker table
 *  carries them all. Users can delete any folder they don't want;
 *  we only seed on startup when the markers table is empty for the
 *  group, so a second boot doesn't revive deleted folders. */
const DEFAULT_FOLDERS: readonly string[] = [
  'Campaigns',
  'World Lore',
  'World Lore/World Info',
  'Assets',
] as const;

/**
 * Returns true if a folder path is a system-managed folder that
 * should never be deleted or renamed by users. Covers:
 *   - Top-level vault sections (Campaigns, World Lore, Assets)
 *   - Per-campaign canonical sub-folders
 */
export function isSystemFolder(path: string): boolean {
  if (path === 'Campaigns' || path === 'World Lore' || path === 'Assets' || path === 'Excalidraw') return true;
  if (/^Campaigns\/[^/]+$/.test(path)) return true;
  if (/^Campaigns\/[^/]+\/(Characters|People|Enemies|Loot|Adventure Log|Places|Creatures|Quests)$/.test(path)) return true;
  return /^World Lore\/World Info$/.test(path);
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

  db.transaction(() => {
    for (const path of DEFAULT_FOLDERS) insertFolder.run(groupId, path, now);
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

// Module-level cache so repeated buildTree() calls within the same
// request flow (page render → /api/tree → tab validate, etc.) reuse
// a single materialised tree. Validity is gated by a cheap snapshot
// query against the source tables, so any mutation (note save,
// folder add/delete) invalidates automatically without explicit
// invalidation logic anywhere else.
type CacheEntry = { tree: Tree; snapshotKey: string };
const treeCache = new Map<string, CacheEntry>();
const TREE_CACHE_MAX = 20;

export type TreeMode = 'player' | 'gm';

function snapshotKey(
  groupId: string,
  hideDmOnly: boolean,
  mode: TreeMode,
): string {
  // Single round-trip: max(updated_at) + count over notes + count
  // over folder_markers + sum of campaign sort_order. Captures every
  // input that buildTree's SELECTs read. ~1ms even on large worlds.
  // sort_order is summed so a reorder bumps the key without anyone
  // having to touch updated_at on a note.
  const row = getDb()
    .query<
      { u: number | null; n: number; m: number; s: number | null },
      [string, string, string, string]
    >(
      `SELECT
         (SELECT COALESCE(MAX(updated_at), 0) FROM notes WHERE group_id = ?) AS u,
         (SELECT COUNT(*) FROM notes WHERE group_id = ?) AS n,
         (SELECT COUNT(*) FROM folder_markers WHERE group_id = ?) AS m,
         (SELECT COALESCE(SUM(sort_order), 0) FROM campaigns WHERE group_id = ?) AS s`,
    )
    .get(groupId, groupId, groupId, groupId);
  const u = row?.u ?? 0;
  const n = row?.n ?? 0;
  const m = row?.m ?? 0;
  const s = row?.s ?? 0;
  return `${u}:${n}:${m}:${s}:${hideDmOnly ? 1 : 0}:${mode}`;
}

function cacheKey(
  groupId: string,
  hideDmOnly: boolean,
  mode: TreeMode,
): string {
  return `${groupId}:${hideDmOnly ? 1 : 0}:${mode}`;
}

export function buildTree(
  groupId: string,
  opts?: { hideDmOnly?: boolean; mode?: TreeMode },
): Tree {
  const hideDmOnly = !!opts?.hideDmOnly;
  const mode: TreeMode = opts?.mode ?? 'player';
  const key = cacheKey(groupId, hideDmOnly, mode);
  const snap = snapshotKey(groupId, hideDmOnly, mode);
  const cached = treeCache.get(key);
  if (cached && cached.snapshotKey === snap) {
    // Re-insert to keep the LRU-ish ordering — Map.set on an
    // existing key bumps it to "most recent" in iteration order.
    treeCache.delete(key);
    treeCache.set(key, cached);
    return cached.tree;
  }
  // GM mode: only gm_only=1 rows. Player mode: only gm_only=0 rows
  // (and additionally hide dm_only when requested).
  const gmClause = mode === 'gm' ? 'gm_only = 1' : 'gm_only = 0';
  const where = hideDmOnly
    ? `WHERE group_id = ? AND dm_only = 0 AND ${gmClause}`
    : `WHERE group_id = ? AND ${gmClause}`;
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

  // Per-campaign ordinal — only the children of the top-level
  // `Campaigns` directory consult this map. All other folders keep
  // alpha ordering.
  const campaignOrder = new Map<string, number>();
  for (const c of getDb()
    .query<{ slug: string; sort_order: number }, [string]>(
      `SELECT slug, sort_order FROM campaigns WHERE group_id = ?`,
    )
    .all(groupId)) {
    campaignOrder.set(c.slug, c.sort_order);
  }

  const root: TreeDir = { kind: 'dir', name: '', path: '', system: false, children: [] };
  let maxUpdated = 0;

  for (const row of rows) {
    if (row.updated_at > maxUpdated) maxUpdated = row.updated_at;
    insert(root, row.path.split('/'), row.path, row.title);
  }
  for (const { path } of markers) {
    ensureFolder(root, path);
  }

  sortTree(root, campaignOrder);
  const tree: Tree = { root, updatedAt: maxUpdated };
  // Bound the cache so an admin in many worlds doesn't grow it
  // forever. FIFO eviction by Map insertion order.
  if (treeCache.size >= TREE_CACHE_MAX) {
    const oldestKey = treeCache.keys().next().value;
    if (oldestKey) treeCache.delete(oldestKey);
  }
  treeCache.set(key, { tree, snapshotKey: snap });
  return tree;
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

function sortTree(dir: TreeDir, campaignOrder: Map<string, number>): void {
  const isCampaignsRoot = dir.path === 'Campaigns';
  dir.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    if (isCampaignsRoot && a.kind === 'dir' && b.kind === 'dir') {
      // Campaign roots are sorted by user-defined ordinal. Missing
      // entries (defensive — backfill should have covered them) sink
      // below ordered ones, then break ties alphabetically.
      const av = campaignOrder.get(a.name);
      const bv = campaignOrder.get(b.name);
      if (av !== undefined && bv !== undefined) {
        if (av !== bv) return av - bv;
      } else if (av !== undefined) {
        return -1;
      } else if (bv !== undefined) {
        return 1;
      }
    }
    return a.name.localeCompare(b.name);
  });
  for (const c of dir.children) if (c.kind === 'dir') sortTree(c, campaignOrder);
}
