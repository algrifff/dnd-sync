import { describe, expect, test } from 'bun:test';
import { canonicalPair, inverseOf, parseRelation, RELATION_TYPES, RELATIONS } from './relation';

describe('RELATIONS', () => {
  test('a symmetric type is its own inverse, with one label', () => {
    for (const type of RELATION_TYPES) {
      const info = RELATIONS[type];
      if (!info.symmetric) continue;
      expect<string>(info.inverse).toBe(type);
      expect(info.inverseLabel).toBe(info.label);
    }
  });

  test('no inverse name is also a stored type, unless the type is symmetric', () => {
    for (const type of RELATION_TYPES) {
      const info = RELATIONS[type];
      if (info.symmetric) continue;
      expect(RELATION_TYPES as readonly string[]).not.toContain(info.inverse);
    }
  });
});

describe('inverseOf', () => {
  test('reads the other direction', () => {
    expect(inverseOf('member_of')).toBe('has_member');
    expect(inverseOf('works_for')).toBe('employs');
    expect(inverseOf('ally_of')).toBe('ally_of');
  });
});

describe('parseRelation', () => {
  test('accepts a stored type in any case, with spaces or hyphens', () => {
    expect(parseRelation('works_for')).toBe('works_for');
    expect(parseRelation('Works For')).toBe('works_for');
    expect(parseRelation(' located-in ')).toBe('located_in');
  });

  test('refuses an inverse, an unknown word and a non-string', () => {
    expect(parseRelation('has_member')).toBeNull();
    expect(parseRelation('rivals')).toBeNull();
    expect(parseRelation(42)).toBeNull();
  });
});

describe('canonicalPair', () => {
  test('orders the paths of a symmetric type so both directions are one row', () => {
    const ab = canonicalPair('a.md', 'ally_of', 'b.md');
    const ba = canonicalPair('b.md', 'ally_of', 'a.md');

    expect(ab).toEqual({ from: 'a.md', relation: 'ally_of', to: 'b.md' });
    expect(ba).toEqual(ab);
  });

  test('keeps the direction of a directed type', () => {
    expect(canonicalPair('b.md', 'member_of', 'a.md')).toEqual({ from: 'b.md', relation: 'member_of', to: 'a.md' });
  });
});
