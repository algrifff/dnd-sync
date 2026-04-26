// Eligibility check for the "rename a folder by editing its index.md
// title" flow. The TitleEditor in the note page calls this to decide
// whether to fire /api/notes/rename-folder-from-index when the user
// finishes typing; the route uses it again as an authoritative guard.
//
// Today the rule is: the path must end in `/index.md` AND the parent
// folder must be either a Campaigns/<slug> root or one of the canonical
// per-campaign subfolders (Characters, People, Enemies, Loot, Adventure
// Log, Places, Creatures, Quests).

import { isCampaignRoot, isCanonicalSubfolder } from './move-policy';

export type RenameableFolder = {
  /** Folder path (no trailing slash, no `/index.md`). */
  folderPath: string;
  /** Parent folder of `folderPath` — destination of the rename. */
  parentPath: string;
  /** Original last segment of `folderPath`. */
  currentName: string;
  /** Always true (we only return Campaigns/<slug> roots). Kept for
   *  callers that still branch on it. */
  isCampaignRoot: true;
};

/** Strip a trailing `/index.md` and return the folder it represents,
 *  or null if the path is not an index note. */
function folderForIndexPath(path: string): string | null {
  const m = /^(.+)\/index\.md$/i.exec(path);
  return m ? (m[1] ?? null) : null;
}

/** Returns the folder eligible for rename, or null when the path is
 *  not the index of a renameable folder.
 *
 *  Only Campaigns/<slug> roots are renameable. Canonical subfolders
 *  (Characters, People, Adventure Log, etc.) are locked — their
 *  display name is part of the app's vocabulary and the AI / sidebar
 *  routing both depend on the segment name, so we keep them fixed. */
export function getRenameableFolderForIndex(
  indexPath: string,
): RenameableFolder | null {
  const folderPath = folderForIndexPath(indexPath);
  if (!folderPath) return null;
  if (!isCampaignRoot(folderPath)) return null;
  const lastSlash = folderPath.lastIndexOf('/');
  const parentPath = lastSlash < 0 ? '' : folderPath.slice(0, lastSlash);
  const currentName = lastSlash < 0 ? folderPath : folderPath.slice(lastSlash + 1);
  return {
    folderPath,
    parentPath,
    currentName,
    isCampaignRoot: true,
  };
}

/** Cheap predicate for the page → TitleEditor wiring. */
export function isRenameableFolderIndex(indexPath: string): boolean {
  return getRenameableFolderForIndex(indexPath) !== null;
}

/** True when the path is the index.md of a canonical subfolder
 *  (Characters / People / Adventure Log / ...). The TitleEditor uses
 *  this to render the title as read-only with the locked folder name
 *  so users can't accidentally retitle a foundational folder. */
export function isLockedFolderIndexTitle(indexPath: string): boolean {
  const folderPath = folderForIndexPath(indexPath);
  if (!folderPath) return false;
  return isCanonicalSubfolder(folderPath);
}

/** Returns the display name to render in the title slot when the
 *  page is a folder index whose name must NOT be edited inline.
 *  Covers both canonical subfolders (Characters / People / ...) and
 *  campaign roots (Campaigns/<slug>) — campaign renames now happen
 *  exclusively from the sidebar "..." menu, so the page-level title
 *  is read-only for both. */
export function lockedFolderTitleFor(indexPath: string): string | null {
  const folderPath = folderForIndexPath(indexPath);
  if (!folderPath) return null;
  if (!isCanonicalSubfolder(folderPath) && !isCampaignRoot(folderPath)) {
    return null;
  }
  const lastSlash = folderPath.lastIndexOf('/');
  return lastSlash < 0 ? folderPath : folderPath.slice(lastSlash + 1);
}
