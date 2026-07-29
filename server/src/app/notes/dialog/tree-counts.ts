// Shared "how much is inside this folder" walker for delete-confirmation
// dialogs. There is no dedicated counts endpoint for folders (or
// campaigns) — both CampaignDeleteDialog and FolderDeleteDialog instead
// fetch the already-existing GET /api/tree (the same payload MoveDialog
// uses to list destinations) and walk the subtree client-side. Counts are
// decorative here: a failed fetch just leaves the dialog without numbers
// rather than blocking the confirm flow.

import type { Tree, TreeDir } from '@/lib/tree';

export type TreeCounts = { notes: number; folders: number };

/** Finds the TreeDir at `path` (a '/'-joined path from the tree root, e.g.
 *  "Campaigns/foo" or "Campaigns/foo/Characters") and counts every note
 *  and nested folder underneath it (not including the folder itself). */
export function countTreeContents(tree: Tree, path: string): TreeCounts | null {
  const segments = path.split('/').filter(Boolean);
  let cursor: TreeDir = tree.root;
  for (const seg of segments) {
    const next = cursor.children.find(
      (c): c is TreeDir => c.kind === 'dir' && c.name === seg,
    );
    if (!next) return null;
    cursor = next;
  }

  let notes = 0;
  let folders = 0;
  const walk = (dir: TreeDir): void => {
    for (const child of dir.children) {
      if (child.kind === 'file') notes++;
      else {
        folders++;
        walk(child);
      }
    }
  };
  walk(cursor);
  return { notes, folders };
}
