import { describe, expect, it } from 'bun:test';
import { verifyCsrf } from './csrf';
import type { Session } from './session';

function fakeRequest(headerValue: string | null): { headers: { get(name: string): string | null } } {
  return {
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'x-csrf-token' ? headerValue : null;
      },
    },
  };
}

const sessionWithToken: Session = {
  id: 's1',
  userId: 'u1',
  username: 'alice',
  displayName: 'Alice',
  accentColor: '#D4A85A',
  currentGroupId: 'default',
  role: 'admin',
  csrfToken: 'a'.repeat(64),
  expiresAt: Date.now() + 60_000,
  cursorMode: 'color',
  avatarVersion: 0,
};

describe('verifyCsrf', () => {
  it('returns null when the header matches the session token', () => {
    const res = verifyCsrf(fakeRequest('a'.repeat(64)), sessionWithToken);
    expect(res).toBeNull();
  });

  it('returns 403 when the header is missing', () => {
    const res = verifyCsrf(fakeRequest(null), sessionWithToken);
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(403);
  });

  it('returns 403 when the header mismatches (same length)', () => {
    const res = verifyCsrf(fakeRequest('b'.repeat(64)), sessionWithToken);
    expect(res?.status).toBe(403);
  });

  it('returns 403 when the header mismatches (different length)', () => {
    const res = verifyCsrf(fakeRequest('short'), sessionWithToken);
    expect(res?.status).toBe(403);
  });
});
