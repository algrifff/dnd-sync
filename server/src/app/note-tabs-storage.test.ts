import { describe, expect, test } from 'bun:test';
import { adoptsLegacyTabs, LEGACY_TABS_KEY, tabsStorageKey } from './note-tabs-storage';

describe('adoptsLegacyTabs', () => {
  test('the first world opened after the upgrade adopts the legacy list', () => {
    expect(adoptsLegacyTabs([LEGACY_TABS_KEY, 'compendium.worldSeen.v2'])).toBe(true);
  });

  test('a legacy list rewritten after some world has its own list is not adopted', () => {
    expect(adoptsLegacyTabs([LEGACY_TABS_KEY, tabsStorageKey('g_other')])).toBe(false);
  });
});
