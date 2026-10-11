import { describe, expect, test } from 'bun:test';
import { canonicalKind, KIND_INPUTS, NOTE_KINDS, parseKind, type KindInput } from './kind';

const EXPECTED: Record<KindInput, string> = {
  character: 'character',
  person: 'person',
  creature: 'creature',
  item: 'item',
  location: 'location',
  quest: 'quest',
  lore: 'lore',
  session: 'session',
  note: 'note',
  pc: 'character',
  npc: 'person',
  ally: 'person',
  villain: 'person',
  monster: 'creature',
};

describe('kind mapping', () => {
  test('canonical kinds are exactly the glossary kinds', () => {
    expect([...NOTE_KINDS].sort()).toEqual(
      ['character', 'creature', 'item', 'location', 'lore', 'note', 'person', 'quest', 'session'],
    );
    expect<string[]>([...KIND_INPUTS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test.each(Object.entries(EXPECTED))('%s maps to %s', (input, kind) => {
    expect(canonicalKind(input as KindInput)).toBe(kind as never);
    expect(parseKind(input)).toBe(kind as never);
    expect(parseKind(input.toUpperCase())).toBe(kind as never);
  });

  test('parseKind returns null for unknown or non-string kinds', () => {
    for (const raw of ['enemy', 'excalidraw', 'page', '', 'constructor', '__proto__', undefined, null, 42]) {
      expect(parseKind(raw)).toBeNull();
    }
  });
});
