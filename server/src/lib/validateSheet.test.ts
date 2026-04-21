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
});
