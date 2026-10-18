import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD_CHIP_PALETTE, worldColor, worldInitials } from './world-chip';

const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

function themeBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf('}', start));
}

describe('world chip palette', () => {
  test('every colour is a token defined in both day and night themes', () => {
    const day = themeBlock(':root');
    const night = themeBlock('[data-theme="night"]');
    for (const colour of WORLD_CHIP_PALETTE) {
      const name = /^var\((--[a-z-]+)\)$/.exec(colour)?.[1];
      expect(name).toBeDefined();
      expect(day).toContain(`${name}:`);
      expect(night).toContain(`${name}:`);
    }
  });

  test('a world keeps its colour across calls', () => {
    expect(worldColor('world-abc')).toBe(worldColor('world-abc'));
  });
});

describe('worldInitials', () => {
  test('uses first and last word, or the first two letters of one word', () => {
    expect(worldInitials('The Shattered Isles')).toBe('TI');
    expect(worldInitials('eberron')).toBe('EB');
    expect(worldInitials('   ')).toBe('?');
  });
});
