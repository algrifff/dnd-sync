import { describe, expect, it } from 'bun:test';
import { pendingSummary, reviewHref } from './wrap-up-inbox';

describe('reviewHref', () => {
  it('should encode each path segment and add the review flag', () => {
    expect(reviewHref('Campaigns/Ash fall/Log/#3.md')).toBe('/notes/Campaigns/Ash%20fall/Log/%233.md?review=1');
  });
});

describe('pendingSummary', () => {
  it('should list non-empty counts with plurals', () => {
    expect(pendingSummary({ mentions: 3, relations: 1, suggestions: 0 })).toBe('3 Notes · 1 Relationship');
  });

  it('should say so when the proposal is empty', () => {
    expect(pendingSummary({ mentions: 0, relations: 0, suggestions: 0 })).toBe('Nothing to add');
  });
});
