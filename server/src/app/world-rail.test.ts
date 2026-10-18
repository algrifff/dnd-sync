import { describe, expect, test } from 'bun:test';
import {
  applyOrder,
  markSeen,
  moveBy,
  moveTo,
  nearestSlot,
  parseLastPages,
  parseSeenMap,
  railShortcut,
  railWorlds,
  reconcileSeen,
  rememberablePath,
  type WorldRow,
} from './world-rail';

function row(id: string, over: Partial<WorldRow> = {}): WorldRow {
  return {
    id,
    name: id.toUpperCase(),
    role: 'editor',
    iconVersion: 0,
    latestActivityAt: null,
    openSession: null,
    ...over,
  };
}

describe('railWorlds', () => {
  test('a world changed after it was last seen is unread', () => {
    const [a] = railWorlds([row('a', { latestActivityAt: 200 })], { a: 100 }, null, null);
    expect(a!.unread).toBe(true);
    expect(a!.label).toBe('A, new activity');
  });

  test('a world unchanged since it was seen is not unread', () => {
    const [a] = railWorlds([row('a', { latestActivityAt: 100 })], { a: 100 }, null, null);
    expect(a!.unread).toBe(false);
    expect(a!.label).toBe('A');
  });

  test('the active world is never unread', () => {
    const [a] = railWorlds([row('a', { latestActivityAt: 200 })], { a: 100 }, 'a', null);
    expect(a!.active).toBe(true);
    expect(a!.unread).toBe(false);
  });

  test('a world never seen is not unread until the seen map has it', () => {
    const [a] = railWorlds([row('a', { latestActivityAt: 200 })], {}, null, null);
    expect(a!.unread).toBe(false);
  });

  test('an open session is live even on the active, seen world', () => {
    const [a] = railWorlds(
      [row('a', { latestActivityAt: 50, openSession: { path: 'S.md' } })],
      { a: 100 },
      'a',
      null,
    );
    expect(a!.live).toBe(true);
    expect(a!.label).toBe('A, session open');
    expect(a!.title).toBe('A · editor · Session open · Alt+1');
  });

  test('only the first nine worlds get a shortcut', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`w${i}`));
    const items = railWorlds(rows, {}, null, null);
    expect(items.map((w) => w.shortcut)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, null]);
    expect(items[9]!.title).toBe('W9 · editor');
  });

  test('pending marks only the world being switched to', () => {
    const items = railWorlds([row('a'), row('b')], {}, 'b', 'b');
    expect(items.map((w) => w.pending)).toEqual([false, true]);
  });
});

describe('reconcileSeen', () => {
  test('a world with no entry is marked seen now, not left to badge', () => {
    const next = reconcileSeen({}, [row('a', { latestActivityAt: 50 })], null, 1000);
    expect(next).toEqual({ a: 1000 });
  });

  test('an existing entry for an inactive world is kept, so its badge survives', () => {
    const next = reconcileSeen({ a: 10 }, [row('a', { latestActivityAt: 50 })], null, 1000);
    expect(next).toEqual({ a: 10 });
  });

  test('the active world is moved to now', () => {
    const next = reconcileSeen({ a: 10 }, [row('a', { latestActivityAt: 50 })], 'a', 1000);
    expect(next).toEqual({ a: 1000 });
  });

  test('activity ahead of the client clock still counts as seen', () => {
    const next = reconcileSeen({ a: 10 }, [row('a', { latestActivityAt: 5000 })], 'a', 1000);
    expect(next).toEqual({ a: 5000 });
  });

  test('returns the same object when nothing changed', () => {
    const seen = { a: 10 };
    expect(reconcileSeen(seen, [row('a')], null, 1000)).toBe(seen);
  });
});

test('markSeen never moves a world backwards', () => {
  expect(markSeen({ a: 500 }, 'a', 100)).toEqual({ a: 500 });
  expect(markSeen({ a: 500 }, 'a', 900)).toEqual({ a: 900 });
});

describe('reorder', () => {
  test('moveTo places the world at the index and keeps the rest in order', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTo(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  test('moveBy clamps at both ends', () => {
    expect(moveBy(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  test('applyOrder keeps a local order over a stale fetch and appends new worlds', () => {
    const rows = [row('a'), row('b'), row('new'), row('c')];
    expect(applyOrder(rows, ['c', 'a', 'b']).map((r) => r.id)).toEqual(['c', 'a', 'b', 'new']);
  });

  test('nearestSlot picks the closest centre', () => {
    expect(nearestSlot([20, 66, 112], 0)).toBe(0);
    expect(nearestSlot([20, 66, 112], 80)).toBe(1);
    expect(nearestSlot([20, 66, 112], 500)).toBe(2);
  });
});

describe('railShortcut', () => {
  const key = (code: string, mods: Partial<Record<'alt' | 'ctrl' | 'meta' | 'shift', boolean>> = {}) => ({
    code,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
  });

  test('Alt+0 is Home and Alt+n is the nth world', () => {
    expect(railShortcut(key('Digit0', { alt: true }))).toEqual({ kind: 'home' });
    expect(railShortcut(key('Digit3', { alt: true }))).toEqual({ kind: 'world', index: 2 });
  });

  test('leaves the browser tab shortcuts and AltGr alone', () => {
    expect(railShortcut(key('Digit1', { ctrl: true }))).toBeNull();
    expect(railShortcut(key('Digit1', { meta: true }))).toBeNull();
    expect(railShortcut(key('Digit1', { alt: true, ctrl: true }))).toBeNull();
    expect(railShortcut(key('Digit1'))).toBeNull();
    expect(railShortcut(key('KeyA', { alt: true }))).toBeNull();
  });
});

describe('rememberablePath', () => {
  test('keeps world pages with their query', () => {
    expect(rememberablePath('/notes/Lore/Dragons.md', '')).toBe('/notes/Lore/Dragons.md');
    expect(rememberablePath('/graph', '?focus=x')).toBe('/graph?focus=x');
    expect(rememberablePath('/home', 'a=1')).toBe('/home?a=1');
  });

  test('drops pages outside a world', () => {
    for (const p of ['/me', '/settings/world', '/admin', '/', '/login', '/homestead', '//evil.com/home']) {
      expect(rememberablePath(p, '')).toBeNull();
    }
  });
});

describe('storage parsing', () => {
  test('parseSeenMap keeps only finite numbers', () => {
    expect(parseSeenMap({ a: 1, b: 'x', c: Infinity })).toEqual({ a: 1 });
    expect(parseSeenMap(['a'])).toEqual({});
    expect(parseSeenMap(null)).toEqual({});
  });

  test('parseLastPages drops anything that is not a world page', () => {
    expect(
      parseLastPages({ a: '/notes/X.md?tab=1', b: 'https://evil.com', c: '/settings/world', d: 3 }),
    ).toEqual({ a: '/notes/X.md?tab=1' });
  });
});
