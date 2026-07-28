import { describe, expect, it } from 'bun:test';
import { adminLoginLimiter, webLoginLimiter, wsAuthLimiter } from './ratelimit';

describe('webLoginLimiter', () => {
  it('allows by default', () => {
    const d = webLoginLimiter.check('ip-a', false);
    expect(d.allowed).toBe(true);
  });

  it('locks after MAX_FAILS failures and clears on success', () => {
    const key = 'ip-b-' + Math.random();
    for (let i = 0; i < 10; i++) {
      const locked = webLoginLimiter.recordFailure(key, false);
      // First lockout returns true on the 10th call.
      if (i === 9) {
        expect(locked).toBe(true);
      } else {
        expect(locked).toBe(false);
      }
    }
    const denied = webLoginLimiter.check(key, false);
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return; // narrow
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    webLoginLimiter.recordSuccess(key);
    expect(webLoginLimiter.check(key, false).allowed).toBe(true);
  });

  it('is exempt when the caller marks the key as such', () => {
    const key = 'ip-c-' + Math.random();
    for (let i = 0; i < 50; i++) webLoginLimiter.recordFailure(key, true);
    expect(webLoginLimiter.check(key, true).allowed).toBe(true);
  });

  it('does not cross-pollinate with wsAuthLimiter', () => {
    const key = 'ip-d-' + Math.random();
    for (let i = 0; i < 10; i++) webLoginLimiter.recordFailure(key, false);
    expect(webLoginLimiter.check(key, false).allowed).toBe(false);
    expect(wsAuthLimiter.check(key, false).allowed).toBe(true);
  });
});

describe('adminLoginLimiter', () => {
  it('allows by default', () => {
    const d = adminLoginLimiter.check('ip-admin-a', false);
    expect(d.allowed).toBe(true);
  });

  it('locks after 10 failures and clears on success', () => {
    const key = 'ip-admin-b-' + Math.random();
    for (let i = 0; i < 10; i++) {
      const locked = adminLoginLimiter.recordFailure(key, false);
      // First lockout returns true on the 10th call.
      if (i === 9) {
        expect(locked).toBe(true);
      } else {
        expect(locked).toBe(false);
      }
    }
    const denied = adminLoginLimiter.check(key, false);
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return; // narrow
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    adminLoginLimiter.recordSuccess(key);
    expect(adminLoginLimiter.check(key, false).allowed).toBe(true);
  });

  it('is exempt when the caller marks the key as such', () => {
    const key = 'ip-admin-c-' + Math.random();
    for (let i = 0; i < 50; i++) adminLoginLimiter.recordFailure(key, true);
    expect(adminLoginLimiter.check(key, true).allowed).toBe(true);
  });

  it('does not cross-pollinate with webLoginLimiter or wsAuthLimiter', () => {
    const key = 'ip-admin-d-' + Math.random();
    for (let i = 0; i < 10; i++) adminLoginLimiter.recordFailure(key, false);
    expect(adminLoginLimiter.check(key, false).allowed).toBe(false);
    expect(webLoginLimiter.check(key, false).allowed).toBe(true);
    expect(wsAuthLimiter.check(key, false).allowed).toBe(true);
  });

  it('stays under the lockout threshold at 9 failures', () => {
    const key = 'ip-admin-e-' + Math.random();
    for (let i = 0; i < 9; i++) adminLoginLimiter.recordFailure(key, false);
    expect(adminLoginLimiter.check(key, false).allowed).toBe(true);
  });
});
