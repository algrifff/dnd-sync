import { describe, expect, it } from 'bun:test';
import { slugify } from './compendium';

// `slugify` is the canonical implementation now imported by every call
// site that previously carried its own byte-identical copy (sessions,
// characters, campaign-index, import-analyse, import-orchestrate,
// sessions/create route, campaigns/delete route). These tests pin its
// behavior so the consolidation can't silently drift.

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Dragon Heist')).toBe('dragon-heist');
  });

  it('trims leading and trailing whitespace before slugifying', () => {
    expect(slugify('  Curse of Strahd  ')).toBe('curse-of-strahd');
  });

  it('collapses runs of non-alphanumeric characters into a single hyphen', () => {
    expect(slugify('One-Shot: The Dancing Demon!!')).toBe('one-shot-the-dancing-demon');
  });

  it('strips leading and trailing hyphens produced by punctuation at the edges', () => {
    expect(slugify('--Loose Ends--')).toBe('loose-ends');
  });

  it('returns an empty string for input with no alphanumeric characters', () => {
    expect(slugify('!!!')).toBe('');
  });

  it('preserves existing lowercase alphanumeric slugs unchanged', () => {
    expect(slugify('already-a-slug-2')).toBe('already-a-slug-2');
  });
});
