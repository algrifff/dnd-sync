import { describe, expect, test } from 'bun:test';
import { CharacterSheet } from './character';

describe('CharacterSheet', () => {
  test('accepts a minimal sheet (fills defaults)', () => {
    const res = CharacterSheet.safeParse({ name: 'Aragorn' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.name).toBe('Aragorn');
      expect(res.data.xp).toBe(0);
      expect(res.data.classes).toEqual([]);
      expect(res.data.currency).toEqual({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });
    }
  });

  test('accepts a multiclass PC with full origin + combat', () => {
    const res = CharacterSheet.safeParse({
      name: 'Mira',
      race: { ref: { name: 'Half-Elf' } },
      classes: [
        { ref: { name: 'Warlock' }, level: 3 },
        { ref: { name: 'Sorcerer' }, level: 2 },
      ],
      ability_scores: { str: 10, dex: 14, con: 12, int: 11, wis: 13, cha: 18 },
      armor_class: { value: 15 },
      hit_points: { max: 38, current: 38, temporary: 0 },
    });
    expect(res.success).toBe(true);
  });

  test('rejects non-numeric level', () => {
    const res = CharacterSheet.safeParse({
      name: 'Bad',
      classes: [{ ref: { name: 'Fighter' }, level: 'banana' }],
    });
    expect(res.success).toBe(false);
  });

  test('legacy flat sheets (no ability_scores / classes) pass under forgiving schema', () => {
    const res = CharacterSheet.safeParse({
      name: 'Legacy',
      // no classes, no race, no ability_scores — forgiving for rollout
    });
    expect(res.success).toBe(true);
  });
});
