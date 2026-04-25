// GM mode — a UI preference that flips the file tree, search, and
// "create note" surfaces from the player namespace (gm_only=0) to
// the GM namespace (gm_only=1). Only effective when the caller's
// session role is 'admin'; non-admin requests with the cookie set
// are silently treated as player mode.

export const GM_MODE_COOKIE = 'compendium_gm_mode';

import type { TreeMode } from './tree';

export function isGmModeOn(
  cookieValue: string | null | undefined,
  role: 'admin' | 'editor' | 'viewer',
): boolean {
  return role === 'admin' && cookieValue === '1';
}

export function treeModeFor(
  cookieValue: string | null | undefined,
  role: 'admin' | 'editor' | 'viewer',
): TreeMode {
  return isGmModeOn(cookieValue, role) ? 'gm' : 'player';
}
