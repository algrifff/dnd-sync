import { describe, expect, test } from 'bun:test';
import { validateSheet } from './validateSheet';

describe('validateSheet', () => {
  test('non-sheeted kinds pass through unchanged', () => {
    const input = { arbitrary: 'stuff' };
    const res = validateSheet('session', input);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe(input);
  });

  test('character sheet validates', () => {
    const res = validateSheet('character', { name: 'Test' });
    expect(res.ok).toBe(true);
  });

  test('malformed character sheet (bad level type) rejected', () => {
    const res = validateSheet('character', {
      name: 'Bad',
      classes: [{ ref: { name: 'X' }, level: 'not-a-number' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.length).toBeGreaterThan(0);
  });

  test('item sheet dispatcher picks ItemSheet', () => {
    const res = validateSheet('item', {
      name: 'X',
      category: 'potion',
      rarity: 'uncommon',
    });
    expect(res.ok).toBe(true);
  });

  test('undefined kind is a pass-through', () => {
    const res = validateSheet(undefined, { any: 'thing' });
    expect(res.ok).toBe(true);
  });

  test('legacy PC sheet with scalar race/background/speed validates', () => {
    // Old PC notes stored these as plain strings / an integer. The
    // PATCH endpoint re-validates the merged sheet on every edit; if
    // the schema rejects these the UI reports "invalid_sheet".
    const res = validateSheet('character', {
      name: 'Legacy',
      race: 'Half-Elf',
      background: 'Sage',
      speed: 30,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as Record<string, unknown>;
      expect(d.race).toEqual({ ref: { name: 'Half-Elf' } });
      expect(d.background).toEqual({ ref: { name: 'Sage' } });
      expect(d.speed).toEqual({ walk: 30 });
    }
  });

  test('legacy creature sheet with scalar speed validates', () => {
    const res = validateSheet('creature', { name: 'Goblin', speed: 30 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as Record<string, unknown>;
      expect(d.speed).toEqual({ walk: 30 });
    }
  });
});
