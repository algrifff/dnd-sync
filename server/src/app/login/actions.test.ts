import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser } from '@/lib/users';

const ADMIN_TOKEN = 'admin-token-for-login-test-0123456789abcdef';

class RedirectSignal extends Error {}

mock.module('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
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
  it('rejects the admin bearer token as a password for another account', async () => {
    const result = await loginAction(null, form('victim', ADMIN_TOKEN));
    expect(result.error).toBe('Unknown username or password.');
  });

  it('accepts the account password', async () => {
    await expect(loginAction(null, form('victim', 'correct-horse-battery'))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
  });
});
