import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser } from '@/lib/users';

const ADMIN_TOKEN = 'admin-token-for-login-test-0123456789abcdef';

class RedirectSignal extends Error {}

let forwardedFor = '203.0.113.7';

mock.module('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': forwardedFor }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
}));
mock.module('next/navigation', () => ({
  redirect: () => {
    throw new RedirectSignal();
  },
}));
mock.module('@/lib/posthog-server', () => ({
  getPostHogClient: async () => ({ identify: () => {}, capture: () => {} }),
}));

const { loginAction } = await import('./actions');

function form(username: string, password: string): FormData {
  const fd = new FormData();
  fd.set('username', username);
  fd.set('password', password);
  return fd;
}

beforeAll(async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  setupTestDb();
  await createUser({
    username: 'victim',
    displayName: 'Victim',
    password: 'correct-horse-battery',
    role: 'viewer',
  });
});
afterAll(() => {
  delete process.env.ADMIN_TOKEN;
  teardownTestDb();
});

describe('loginAction', () => {
  beforeEach(() => {
    forwardedFor = '203.0.113.7';
  });

  it('rejects the admin bearer token as a password for another account', async () => {
    const result = await loginAction(null, form('victim', ADMIN_TOKEN));
    expect(result.error).toBe('Unknown username or password.');
  });

  it('accepts the account password', async () => {
    await expect(loginAction(null, form('victim', 'correct-horse-battery'))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
  });

  it('shares one rate-limit bucket across requests that differ only in the client-supplied first X-Forwarded-For entry', async () => {
    // Arrange: ten failures, each claiming a different origin, all seen by the proxy as 198.51.100.1
    for (let i = 0; i < 10; i++) {
      forwardedFor = `10.0.0.${i}, 198.51.100.1`;
      await loginAction(null, form('victim', 'wrong-password'));
    }

    // Act: the right password, yet another forged first entry, same proxy-seen address
    forwardedFor = '10.9.9.9, 198.51.100.1';
    const result = await loginAction(null, form('victim', 'correct-horse-battery'));

    // Assert
    expect(result.error).toMatch(/Too many failed attempts/);
  });

  it('keeps separate buckets for different proxy-seen addresses even when the first entry matches', async () => {
    // Arrange: ten failures behind one forged first entry, each seen as a different address
    for (let i = 0; i < 10; i++) {
      forwardedFor = `10.1.1.1, 198.51.101.${i}`;
      await loginAction(null, form('victim', 'wrong-password'));
    }

    // Act: same first entry, a further distinct proxy-seen address, right password
    forwardedFor = '10.1.1.1, 198.51.101.200';

    // Assert
    await expect(loginAction(null, form('victim', 'correct-horse-battery'))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
  });
});
