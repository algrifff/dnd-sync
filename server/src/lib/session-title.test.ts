import { describe, expect, it } from 'bun:test';
import { generateSessionTitle } from './session-title';

describe('generateSessionTitle', () => {
  it('should join number, creator and date', () => {
    expect(generateSessionTitle(3, 'Alex', '2026-10-19')).toBe('Session 3_Alex_2026-10-19');
  });

  it('should drop the creator when the display name is blank', () => {
    expect(generateSessionTitle(3, '   ', '2026-10-19')).toBe('Session 3_2026-10-19');
  });
});
