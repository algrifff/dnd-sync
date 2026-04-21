import { describe, expect, test } from 'bun:test';
import { ItemSheet } from './item';

describe('ItemSheet', () => {
  test('weapon with modifiers validates', () => {
    const res = ItemSheet.safeParse({
      name: 'Flame Tongue',
      category: 'weapon',
      rarity: 'rare',
      weight: 3,
      requires_attunement: true,
      weapon: {
        category: 'martial',
        damage: { dice: { count: 1, sides: 8 }, type: 'slashing' },
        range: { normal: 5 },
        properties: ['versatile'],
      },
      modifiers: [
        { target: 'damage_bonus', op: '+', value: 2, when: 'attuned' },
      ],
    });
    expect(res.success).toBe(true);
  });

  test('rejects malformed modifier (unknown target)', () => {
    const res = ItemSheet.safeParse({
      name: 'Bad',
      modifiers: [{ target: 'ability.not_a_stat', op: '+', value: 1, when: 'always' }],
    });
    expect(res.success).toBe(false);
  });

  test('fills defaults for bare item', () => {
    const res = ItemSheet.safeParse({ name: 'Lantern' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.category).toBe('other');
      expect(res.data.rarity).toBe('common');
      expect(res.data.modifiers).toEqual([]);
    }
  });
});
