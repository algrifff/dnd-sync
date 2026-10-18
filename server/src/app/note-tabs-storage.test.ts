import { describe, expect, test } from 'bun:test';
import { adoptsLegacyTabs, LEGACY_TABS_KEY, parseTabs, tabsStorageKey } from './note-tabs-storage';

describe('parseTabs', () => {
  test('keeps well-formed tabs and drops the rest', () => {
    const raw = JSON.stringify([{ path: 'a.md', title: 'a' }, { path: 1, title: 'x' }, null, 'b.md']);
    expect(parseTabs(raw)).toEqual([{ path: 'a.md', title: 'a' }]);
  });

  test('reads a missing, malformed or non-list value as no tabs', () => {
    expect(parseTabs(null)).toEqual([]);
    expect(parseTabs('{not json')).toEqual([]);
    expect(parseTabs('{"path":"a.md"}')).toEqual([]);
  });
});

describe('adoptsLegacyTabs', () => {
  test('the first world opened after the upgrade adopts the legacy list', () => {
    expect(adoptsLegacyTabs([LEGACY_TABS_KEY, 'compendium.worldSeen.v2'])).toBe(true);
  });

  test('a legacy list rewritten after some world has its own list is not adopted', () => {
    expect(adoptsLegacyTabs([LEGACY_TABS_KEY, tabsStorageKey('g_other')])).toBe(false);
  });
});
