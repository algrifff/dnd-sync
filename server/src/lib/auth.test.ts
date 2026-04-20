import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  parseBearer,
  requireAdminAuth,
  requireRequestAuth,
  verifyToken,
} from './auth';

const FAKE_ADMIN = 'test-admin-token-abcdef1234567890';
const FAKE_PLAYER = 'test-player-token-abcdef1234567890';

beforeAll(() => {
  process.env.ADMIN_TOKEN = FAKE_ADMIN;
  process.env.PLAYER_TOKEN = FAKE_PLAYER;
});

afterAll(() => {
  delete process.env.ADMIN_TOKEN;
  delete process.env.PLAYER_TOKEN;
});

// ── parseBearer ────────────────────────────────────────────────────────

describe('parseBearer', () => {
  it('extracts token from a well-formed Authorization header', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseBearer('bearer abc123')).toBe('abc123');
    expect(parseBearer('BEARER abc123')).toBe('abc123');
  });

  it('trims trailing whitespace from the token', () => {
    expect(parseBearer('Bearer   mytoken  ')).toBe('mytoken');
  });

  it('returns null for a null/undefined header', () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });

  it('returns null for an empty header', () => {
    expect(parseBearer('')).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(parseBearer('Basic dXNlcjpwYXNz')).toBeNull();
    expect(parseBearer('Token abc123')).toBeNull();
  });

  it('returns null for "Bearer" with no token', () => {
    expect(parseBearer('Bearer')).toBeNull();
    expect(parseBearer('Bearer ')).toBeNull();
  });
});

// ── verifyToken ────────────────────────────────────────────────────────

describe('verifyToken', () => {
  it('returns null for null/undefined', () => {
    expect(verifyToken(null)).toBeNull();
    expect(verifyToken(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(verifyToken('')).toBeNull();
  });

  it('returns null for an unknown token', () => {
    expect(verifyToken('totally-bogus-token-xyz')).toBeNull();
  });

  it('returns admin for the admin token', () => {
    expect(verifyToken(FAKE_ADMIN)).toBe('admin');
  });

  it('returns player for the player token', () => {
    expect(verifyToken(FAKE_PLAYER)).toBe('player');
  });

  it('is timing-safe — wrong-length tokens are rejected without panic', () => {
    expect(verifyToken('short')).toBeNull();
    expect(verifyToken('x'.repeat(500))).toBeNull();
  });
});

// ── requireRequestAuth ─────────────────────────────────────────────────

function makeReq(headers: Record<string, string>, url = 'http://localhost/'): Request {
  return new Request(url, { headers });
}

describe('requireRequestAuth', () => {
  it('returns the role when Authorization header carries a valid token', () => {
    const req = makeReq({ Authorization: `Bearer ${FAKE_ADMIN}` });
    expect(requireRequestAuth(req)).toBe('admin');
  });

  it('returns the role when token is passed as a query parameter', () => {
    const req = makeReq({}, `http://localhost/?token=${FAKE_PLAYER}`);
    expect(requireRequestAuth(req)).toBe('player');
  });

  it('prefers the Authorization header over the query param', () => {
    const req = makeReq(
      { Authorization: `Bearer ${FAKE_ADMIN}` },
      `http://localhost/?token=${FAKE_PLAYER}`,
    );
    expect(requireRequestAuth(req)).toBe('admin');
  });

  it('returns a 401 Response when no token is present', async () => {
    const req = makeReq({});
    const result = requireRequestAuth(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    const body = await (result as Response).json();
    expect(body).toMatchObject({ error: 'unauthorized' });
  });

  it('returns a 401 Response for an invalid token', async () => {
    const req = makeReq({ Authorization: 'Bearer bad-token' });
    const result = requireRequestAuth(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});

// ── requireAdminAuth ───────────────────────────────────────────────────

describe('requireAdminAuth', () => {
  it('returns admin role for the admin token', () => {
    const req = makeReq({ Authorization: `Bearer ${FAKE_ADMIN}` });
    expect(requireAdminAuth(req)).toBe('admin');
  });

  it('returns a 403 Response for a player token', async () => {
    const req = makeReq({ Authorization: `Bearer ${FAKE_PLAYER}` });
    const result = requireAdminAuth(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    const body = await (result as Response).json();
    expect(body).toMatchObject({ error: 'admin only' });
  });

  it('returns a 401 Response when no token is present', () => {
    const req = makeReq({});
    const result = requireAdminAuth(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});
