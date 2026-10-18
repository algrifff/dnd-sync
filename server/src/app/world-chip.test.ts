import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD_CHIPS, worldChipStyle, worldInitials } from './world-chip';

const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf('}', start));
  return new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const day = tokens(':root');
const night = new Map([...day, ...tokens('[data-theme="night"]')]);

/** A `var(--x)` or hex value resolved to its hex, the way the cascade
 *  resolves it on <html> in that theme. */
function resolve(theme: Map<string, string>, value: string): string {
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
  if (!ref) return value;
  const next = theme.get(ref);
  if (next === undefined) throw new Error(`${ref} is not defined`);
  return resolve(theme, next);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('world chips', () => {
  // Initials are 14px and 9px semibold, below WCAG's large-text size,
  // so every chip needs the normal-text AA ratio.
  for (const [name, theme] of [
    ['day', day],
    ['night', night],
  ] as const) {
    test(`every chip's initials reach 4.5:1 in the ${name} theme`, () => {
      const unreadable = WORLD_CHIPS.map((chip) => ({
        chip,
        ratio: contrast(resolve(theme, `var(--chip-${chip})`), resolve(theme, `var(--chip-${chip}-ink)`)),
      }))
        .filter(({ ratio }) => ratio < 4.5)
        .map(({ chip, ratio }) => `${chip} ${ratio.toFixed(2)}:1`);
      expect(unreadable).toEqual([]);
    });
  }

  test('a world keeps its chip across calls, and ids spread across chips', () => {
    expect(worldChipStyle('world-abc')).toEqual(worldChipStyle('world-abc'));
    const used = new Set(Array.from({ length: 64 }, (_, i) => worldChipStyle(`world-${i}`).backgroundColor));
    expect(used.size).toBe(WORLD_CHIPS.length);
  });
});

describe('worldInitials', () => {
  test('uses first and last word, or the first two letters of one word', () => {
    expect(worldInitials('The Shattered Isles')).toBe('TI');
    expect(worldInitials('eberron')).toBe('EB');
    expect(worldInitials('   ')).toBe('?');
  });
});
