import { describe, expect, test } from 'bun:test';
import {
  abilityModifier,
  formatClassList,
  formatModifier,
  normalizeKind,
  refName,
} from './util';

describe('normalizeKind', () => {
  test('maps canonical kinds to themselves', () => {
    expect(normalizeKind('character')).toBe('character');
    expect(normalizeKind('person')).toBe('person');
    expect(normalizeKind('creature')).toBe('creature');
    expect(normalizeKind('item')).toBe('item');
    expect(normalizeKind('location')).toBe('location');
  });

  test('maps legacy aliases', () => {
    expect(normalizeKind('pc')).toBe('character');
    expect(normalizeKind('ally')).toBe('character');
    expect(normalizeKind('npc')).toBe('person');
    expect(normalizeKind('villain')).toBe('person');
    expect(normalizeKind('monster')).toBe('creature');
  });

  test('is case-insensitive', () => {
    expect(normalizeKind('Character')).toBe('character');
    expect(normalizeKind('MONSTER')).toBe('creature');
  });

  test('returns null for unknown or non-string kinds', () => {
    expect(normalizeKind('lore')).toBeNull();
    expect(normalizeKind('session')).toBeNull();
    expect(normalizeKind('note')).toBeNull();
    expect(normalizeKind('')).toBeNull();
    expect(normalizeKind(undefined)).toBeNull();
    expect(normalizeKind(null)).toBeNull();
    expect(normalizeKind(42)).toBeNull();
  });
});

describe('abilityModifier', () => {
  test('matches floor((score - 10) / 2)', () => {
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(11)).toBe(0);
    expect(abilityModifier(12)).toBe(1);
    expect(abilityModifier(15)).toBe(2);
    expect(abilityModifier(20)).toBe(5);
    expect(abilityModifier(9)).toBe(-1);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(7)).toBe(-2);
    expect(abilityModifier(1)).toBe(-5);
  });

  test('returns 0 for non-finite inputs', () => {
    expect(abilityModifier(NaN)).toBe(0);
    expect(abilityModifier(Infinity)).toBe(0);
  });
});

describe('formatModifier', () => {
  test('prefixes non-negative values with +', () => {
    expect(formatModifier(0)).toBe('+0');
    expect(formatModifier(3)).toBe('+3');
  });
  test('keeps native sign for negatives', () => {
    expect(formatModifier(-1)).toBe('-1');
    expect(formatModifier(-5)).toBe('-5');
  });
});

describe('formatClassList', () => {
  test('joins ref.name + level pairs', () => {
    expect(
      formatClassList([
        { ref: { name: 'Warlock' }, level: 3 },
        { ref: { name: 'Sorcerer' }, level: 2 },
      ]),
    ).toBe('Warlock 3 / Sorcerer 2');
  });

  test('falls back to flat name / skips invalid entries', () => {
    expect(formatClassList([{ name: 'Bard', level: 5 }, null, 'junk'])).toBe(
      'Bard 5',
    );
  });

  test('omits level when missing', () => {
    expect(formatClassList([{ ref: { name: 'Rogue' } }])).toBe('Rogue');
  });

  test('returns empty string for non-arrays', () => {
    expect(formatClassList(undefined)).toBe('');
    expect(formatClassList('Fighter')).toBe('');
  });
});

describe('refName', () => {
  test('extracts name from ref-shaped object', () => {
    expect(refName({ ref: { name: 'Fireball' } })).toBe('Fireball');
  });
  test('falls back to flat string', () => {
    expect(refName('Healing Word')).toBe('Healing Word');
  });
  test('returns null otherwise', () => {
    expect(refName(null)).toBeNull();
    expect(refName({})).toBeNull();
    expect(refName(5)).toBeNull();
  });
});
