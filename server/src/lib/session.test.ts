import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getDb } from './db';
import {
  createSession,
  destroySession,
  hashPassword,
  parseCookies,
  readSession,
  rotateSession,
  sessionCookieName,
  verifyPassword,
} from './session';
import { createUser, DEFAULT_GROUP_ID, ensureDefaultAdmin, findUserByUsername } from './users';
import { setupTestDb, teardownTestDb } from './test-utils';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM group_members');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
});

async function makeUser(): Promise<{ id: string }> {
  const u = await createUser({
    username: 'alice',
    displayName: 'Alice',
    password: 'password-one',
    role: 'admin',
  });
  return { id: u.id };
}

function cookieHeaderFor(sid: string): string {
  return `${sessionCookieName()}=${sid}`;
}

describe('hashPassword / verifyPassword', () => {
  it('round-trips a valid password', async () => {
    const hash = await hashPassword('hunter22-ok');
    expect(await verifyPassword('hunter22-ok', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('wrong-horse', hash)).toBe(false);
  });

  it('returns false for a malformed hash', async () => {
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false);
  });

  it('rejects a too-short password at hash time', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/8 characters/);
  });
});

describe('createSession / readSession', () => {
  it('creates a row and reads it back through the cookie', async () => {
    const user = await makeUser();
    const session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID });
    const round = readSession(cookieHeaderFor(session.id));
    expect(round).not.toBeNull();
    expect(round?.userId).toBe(user.id);
    expect(round?.role).toBe('admin');
    expect(round?.currentGroupId).toBe(DEFAULT_GROUP_ID);
  });

  it('returns null when no cookie is present', () => {
    expect(readSession(null)).toBeNull();
    expect(readSession('')).toBeNull();
    expect(readSession('other=value')).toBeNull();
  });

  it('returns null for an unknown session id', () => {
    expect(readSession(cookieHeaderFor('nope'))).toBeNull();
  });

  it('deletes and rejects an expired session on read', async () => {
    const user = await makeUser();
    const session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID });
    getDb().query('UPDATE sessions SET expires_at = ? WHERE id = ?').run(1, session.id);
    expect(readSession(cookieHeaderFor(session.id))).toBeNull();
    const remaining = getDb()
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM sessions WHERE id = ?')
      .get(session.id);
    expect(remaining?.n).toBe(0);
  });
});

describe('rotateSession', () => {
  it('invalidates the old id and issues a new one', async () => {
    const user = await makeUser();
    const first = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID });
    const second = rotateSession(first.id, {
      userId: user.id,
      groupId: DEFAULT_GROUP_ID,
    });
    expect(second.id).not.toBe(first.id);
    expect(readSession(cookieHeaderFor(first.id))).toBeNull();
    expect(readSession(cookieHeaderFor(second.id))).not.toBeNull();
  });

  it('is safe to call with null old id', async () => {
    const user = await makeUser();
    const fresh = rotateSession(null, { userId: user.id, groupId: DEFAULT_GROUP_ID });
    expect(readSession(cookieHeaderFor(fresh.id))).not.toBeNull();
  });
});

describe('destroySession', () => {
  it('removes the row', async () => {
    const user = await makeUser();
    const s = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID });
    destroySession(s.id);
    expect(readSession(cookieHeaderFor(s.id))).toBeNull();
  });

  it('is idempotent on a missing id', () => {
    destroySession('anything');
    destroySession('');
  });
});

describe('parseCookies', () => {
  it('returns an empty map for null/empty input', () => {
    expect(parseCookies(null).size).toBe(0);
    expect(parseCookies('').size).toBe(0);
  });

  it('splits multi-cookie headers and trims whitespace', () => {
    const m = parseCookies('a=1; b=two ;   c=3');
    expect(m.get('a')).toBe('1');
    expect(m.get('b')).toBe('two');
    expect(m.get('c')).toBe('3');
  });
});

describe('ensureDefaultAdmin', () => {
  it('creates admin on an empty DB and nothing on a populated one', async () => {
    const first = await ensureDefaultAdmin();
    expect(first.created).toBe(true);
    if (!first.created) return; // narrow for TS
    expect(first.username).toBe('admin');
    expect(first.password.length).toBeGreaterThanOrEqual(24);

    const second = await ensureDefaultAdmin();
    expect(second.created).toBe(false);

    // Round-trip: verify the generated password actually logs us in.
    const adminRow = findUserByUsername('admin');
    expect(adminRow).not.toBeNull();
    expect(await verifyPassword(first.password, adminRow!.passwordHash)).toBe(true);
  });
});
