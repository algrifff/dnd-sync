// Where each world's open note tabs live in localStorage.

const TABS_PREFIX = 'compendium.tabs.v2:';

// One list shared by every world, from before tabs were per world.
// Opening a world pruned the other worlds' notes out of it.
export const LEGACY_TABS_KEY = 'compendium.tabs.v1';

export function tabsStorageKey(groupId: string): string {
  return `${TABS_PREFIX}${groupId}`;
}

/** Whether the world being opened may adopt the legacy shared list.
 *  Only the first world opened after the upgrade does. Once any world
 *  has its own list, a legacy list can only have been rewritten since by
 *  an old tab, and could belong to any world. */
export function adoptsLegacyTabs(storageKeys: Iterable<string>): boolean {
  for (const key of storageKeys) {
    if (key.startsWith(TABS_PREFIX)) return false;
  }
  return true;
}
