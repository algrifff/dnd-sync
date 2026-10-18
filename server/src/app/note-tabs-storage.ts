// Where each world's open note tabs live in localStorage.

export type StoredTab = { path: string; title: string };

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

/** The well-formed tabs in a stored list; anything else reads as none. */
export function parseTabs(raw: string | null): StoredTab[] {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (t): t is StoredTab =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as StoredTab).path === 'string' &&
      typeof (t as StoredTab).title === 'string',
  );
}

/** A world's open tabs. The first world opened after the upgrade takes
 *  over the legacy shared list, which is then dropped. */
export function readTabs(groupId: string): StoredTab[] {
  try {
    let raw = localStorage.getItem(tabsStorageKey(groupId));
    if (raw === null) {
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '');
      if (adoptsLegacyTabs(keys)) raw = localStorage.getItem(LEGACY_TABS_KEY);
      localStorage.removeItem(LEGACY_TABS_KEY);
    }
    return parseTabs(raw);
  } catch {
    return [];
  }
}

export function writeTabs(groupId: string, tabs: readonly StoredTab[]): void {
  try {
    localStorage.setItem(tabsStorageKey(groupId), JSON.stringify(tabs));
  } catch {
    /* quota or private mode: tabs just won't survive a reload */
  }
}
