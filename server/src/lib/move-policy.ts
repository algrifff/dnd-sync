// Path-based authorisation for note + folder moves. Pure: no DB access,
// no side effects — same module is consumed by the move API routes
// (authoritative) and by FileTree's drag-and-drop validator (UX hint).
//
// Rules (see /Users/magig/.claude/plans/i-am-noticing-a-mutable-sedgewick.md
// for the source-of-truth matrix):
//   • Player characters (anything under Campaigns/<slug>/Characters/) are
//     locked from any move.
//   • Campaign root folders (Campaigns/<slug>) are locked.
//   • Canonical subfolders (Characters, People, Enemies, Loot, Adventure
//     Log, Places, Creatures, Quests, World Lore/World Info) are locked.
//   • Session notes (under Campaigns/<slug>/Adventure Log/) can only land
//     inside their *own* campaign's Adventure Log.
//   • Everything else can land anywhere inside a Campaigns/<slug>/...
//     subtree (except Characters) or anywhere inside World Lore/... .
//   • Vault root, the bare top-level headings, and Assets are never
//     valid destinations.

export type MoveKind = 'file' | 'folder';

export type MovePolicyResult =
  | { ok: true }
  | { ok: false; error: string; reason: string };

const TOP_LEVEL: ReadonlySet<string> = new Set(['Campaigns', 'World Lore', 'Assets']);

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function campaignSlug(path: string): string | null {
  const m = /^Campaigns\/([^/]+)(?:\/|$)/.exec(path);
  return m ? (m[1] ?? null) : null;
}

function isUnderWorldLore(path: string): boolean {
  return path === 'World Lore' || path.startsWith('World Lore/');
}

function isUnderCharacters(path: string): boolean {
  return /^Campaigns\/[^/]+\/Characters(\/|$)/.test(path);
}

function isUnderAdventureLog(path: string): boolean {
  return /^Campaigns\/[^/]+\/Adventure Log(\/|$)/.test(path);
}

export function isCampaignRoot(path: string): boolean {
  return /^Campaigns\/[^/]+$/.test(path);
}

/** Pull the slug out of a `Campaigns/<slug>` path; null if not a
 *  campaign root. */
export function campaignRootSlug(path: string): string | null {
  const m = /^Campaigns\/([^/]+)$/.exec(path);
  return m ? (m[1] ?? null) : null;
}

export function isCanonicalSubfolder(path: string): boolean {
  return (
    /^Campaigns\/[^/]+\/(Characters|People|Enemies|Loot|Adventure Log|Places|Creatures|Quests)$/.test(path) ||
    path === 'World Lore/World Info'
  );
}

function isAssets(path: string): boolean {
  return path === 'Assets' || path.startsWith('Assets/');
}

/** Build the new path that would result from dropping `src` into
 *  `destFolder`. Mirror of the construction in FileTree.moveEntry so the
 *  UI helper and server policy stay in step. */
export function pathAfterMove(srcPath: string, destFolder: string): string {
  const base = basenameOf(srcPath);
  return destFolder ? destFolder + '/' + base : base;
}

/** Top-level entry point. Returns { ok: true } if the move is legal,
 *  otherwise { ok: false, error, reason } with a stable snake_case code
 *  so route handlers can pass it straight to the wire. */
export function assertMoveAllowed(args: {
  kind: MoveKind;
  from: string;
  to: string;
}): MovePolicyResult {
  const { kind, from, to } = args;

  if (!from || !to) {
    return { ok: false, error: 'invalid_path', reason: 'empty path' };
  }
  if (from === to) return { ok: true };

  // ---------- source locks ----------
  if (TOP_LEVEL.has(from)) {
    return { ok: false, error: 'top_level_locked', reason: `${from} is a top-level section` };
  }
  if (isAssets(from)) {
    return { ok: false, error: 'assets_locked', reason: 'assets are not draggable' };
  }
  if (kind === 'folder' && isCampaignRoot(from)) {
    return { ok: false, error: 'campaign_locked', reason: 'campaigns cannot be moved' };
  }
  if (kind === 'folder' && isCanonicalSubfolder(from)) {
    return { ok: false, error: 'canonical_folder_locked', reason: 'canonical subfolder cannot be moved' };
  }
  // PC lock — anything at-or-under Characters/ (file or user subfolder).
  if (isUnderCharacters(from)) {
    return { ok: false, error: 'pc_locked', reason: 'player characters cannot be moved' };
  }

  // ---------- destination shape ----------
  const destFolder = parentOf(to);
  if (!destFolder) {
    return { ok: false, error: 'invalid_destination', reason: 'cannot move to vault root' };
  }
  // Bare 'Campaigns' and 'Assets' headings are never valid destinations.
  // 'World Lore' itself IS allowed (it's a section, not just a heading) —
  // anything inside it counts as living in the World Lore section.
  if (destFolder === 'Campaigns') {
    return { ok: false, error: 'invalid_destination', reason: 'cannot drop directly under Campaigns' };
  }
  if (isAssets(destFolder)) {
    return { ok: false, error: 'invalid_destination', reason: 'cannot move into Assets' };
  }
  const dstSlug = campaignSlug(destFolder);
  const dstInWorldLore = isUnderWorldLore(destFolder);
  if (!dstSlug && !dstInWorldLore) {
    return {
      ok: false,
      error: 'invalid_destination',
      reason: 'destination must be inside a campaign or World Lore',
    };
  }
  if (isUnderCharacters(destFolder)) {
    return {
      ok: false,
      error: 'characters_locked',
      reason: 'only player characters belong in Characters/',
    };
  }

  // ---------- session-note confinement ----------
  if (isUnderAdventureLog(from)) {
    if (!isUnderAdventureLog(destFolder)) {
      return {
        ok: false,
        error: 'session_outside_adventure_log',
        reason: 'sessions can only be moved within an Adventure Log',
      };
    }
    const srcSlug = campaignSlug(from);
    if (srcSlug && dstSlug && srcSlug !== dstSlug) {
      return {
        ok: false,
        error: 'session_cross_campaign',
        reason: 'sessions cannot move between campaigns',
      };
    }
  }

  // ---------- folder self-containment ----------
  if (kind === 'folder' && (to + '/').startsWith(from + '/')) {
    return { ok: false, error: 'cannot_move_into_self', reason: 'cannot move folder into itself' };
  }

  return { ok: true };
}

/** Convenience for the UI: caller has src + the target folder it's
 *  hovering. Returns the same MovePolicyResult shape. */
export function canDropOn(
  src: { kind: MoveKind; path: string },
  destFolder: string,
): MovePolicyResult {
  const to = pathAfterMove(src.path, destFolder);
  return assertMoveAllowed({ kind: src.kind, from: src.path, to });
}

/** True iff this source is allowed to *initiate* a drag at all. Used to
 *  suppress draggable on PC files / locked folders so the cursor stays
 *  default. Does not consider any specific destination. */
export function isDraggableSource(src: { kind: MoveKind; path: string }): boolean {
  if (TOP_LEVEL.has(src.path)) return false;
  if (isAssets(src.path)) return false;
  // Campaign roots are draggable for sibling-reorder. They still fail
  // canDropOn for any folder destination so they can't be nested —
  // the only legal drop target is a between-rows reorder gap.
  if (src.kind === 'folder' && isCanonicalSubfolder(src.path)) return false;
  if (isUnderCharacters(src.path)) return false;
  return true;
}
