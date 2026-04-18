// Builds a folder tree for the current group's notes. Consumed by the
// /api/tree endpoint + the server-side FileTree render on note pages.

import { getDb } from './db';

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
  children: Array<TreeDir | TreeFile>;
};

export type Tree = {
  root: TreeDir;
  updatedAt: number;
};

export function buildTree(groupId: string): Tree {
  const rows = getDb()
    .query<
      { path: string; title: string; updated_at: number },
      [string]
    >(`SELECT path, title, updated_at FROM notes WHERE group_id = ? ORDER BY path`)
    .all(groupId);

  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  let maxUpdated = 0;

  for (const row of rows) {
    if (row.updated_at > maxUpdated) maxUpdated = row.updated_at;
    insert(root, row.path.split('/'), row.path, row.title);
  }

  sortTree(root);
  return { root, updatedAt: maxUpdated };
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
    child = {
      kind: 'dir',
      name: head,
      path: dir.path ? `${dir.path}/${head}` : head,
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
