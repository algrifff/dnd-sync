import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { NextRequest } from 'next/server';

const ADMIN_TOKEN = 'admin-token-for-route-test-0123456789abcdef';

const { POST } = await import('./route');

function attempt(token: string, forwardedFor: string): Promise<Response> {
  const req = new Request('http://localhost/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ token }),
  });
  return POST(req as unknown as NextRequest);
}

beforeAll(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
});
afterAll(() => {
  delete process.env.ADMIN_TOKEN;
});

describe('POST /api/admin/login rate limiting', () => {
  it('shares one bucket across requests that differ only in the client-supplied first X-Forwarded-For entry', async () => {
    // Arrange: ten bad tokens, each claiming a different origin, all seen as 198.51.100.1
    for (let i = 0; i < 10; i++) {
      expect((await attempt('wrong', `10.0.0.${i}, 198.51.100.1`)).status).toBe(401);
    }

    // Act: yet another forged first entry, same proxy-seen address
    const res = await attempt('wrong', '10.9.9.9, 198.51.100.1');

    // Assert
    expect(res.status).toBe(429);
  });

  it('keeps separate buckets for different proxy-seen addresses even when the first entry matches', async () => {
    // Arrange: ten bad tokens behind one forged first entry, each seen as a different address
    for (let i = 0; i < 10; i++) {
      expect((await attempt('wrong', `10.1.1.1, 198.51.101.${i}`)).status).toBe(401);
    }

    // Act: same first entry, a further distinct proxy-seen address, right token
    const res = await attempt(ADMIN_TOKEN, '10.1.1.1, 198.51.101.200');

    // Assert
    expect(res.status).toBe(200);
  });
});
