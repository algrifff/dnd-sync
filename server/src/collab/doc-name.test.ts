// The wire name a browser client sends must survive `onAuthenticate`'s
// tenant-boundary check. Regression: PresenceClient and the graph
// canvases kept sending `.presence:<id>` / `.graph-state:<id>` /
// `graph-groups:<id>` after documents became `${groupId}:${path}`, so
// the server parsed the group as ".presence" and rejected every
// connection.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from '@/lib/db';
import { createUser } from '@/lib/users';
import { createSession, sessionCookieName } from '@/lib/session';
import {
  graphGroupsDocName,
  graphStateDocName,
  parseDocName,
  presenceDocName,
  qualifiedDocName,
} from '@/lib/collab-doc-name';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { collabServer } from './server';

const OWN_GROUP = 'grp-docname-own';
const OTHER_GROUP = 'grp-docname-other';

let cookie = '';

beforeAll(async () => {
  setupTestDb();
  const db = getDb();
  for (const id of [OWN_GROUP, OTHER_GROUP]) {
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
      id,
      id,
      Date.now(),
    );
  }
  const user = await createUser({
    username: 'docname-player',
    displayName: 'Player',
    password: 'password-one',
    role: 'viewer',
    groupId: OWN_GROUP,
  });
  const session = createSession({ userId: user.id, groupId: OWN_GROUP });
  cookie = `${sessionCookieName()}=${session.id}`;
});

afterAll(() => {
  teardownTestDb();
});

/** Run the real `onAuthenticate` hook for `documentName` as the seeded player. */
async function authenticate(documentName: string): Promise<unknown> {
  const hook = collabServer.configuration.onAuthenticate as (data: unknown) => Promise<unknown>;
  return hook({
    documentName,
    socketId: 'test-socket',
    request: { headers: { cookie } },
    connectionConfig: { readOnly: false },
  });
}

describe('collab document names', () => {
  it('should round-trip each meta doc through parseDocName', () => {
    expect(parseDocName(presenceDocName(OWN_GROUP))).toEqual({
      groupId: OWN_GROUP,
      path: `.presence:${OWN_GROUP}`,
    });
    expect(parseDocName(graphStateDocName(OWN_GROUP))).toEqual({
      groupId: OWN_GROUP,
      path: `.graph-state:${OWN_GROUP}`,
    });
    expect(parseDocName(graphGroupsDocName(OWN_GROUP))).toEqual({
      groupId: OWN_GROUP,
      path: `graph-groups:${OWN_GROUP}`,
    });
  });

  it('should keep colons inside a note path when parsing', () => {
    expect(parseDocName(qualifiedDocName(OWN_GROUP, 'Lore/a:b.md'))).toEqual({
      groupId: OWN_GROUP,
      path: 'Lore/a:b.md',
    });
  });
});

describe('onAuthenticate with client-built meta doc names', () => {
  it.each([
    ['presence', presenceDocName],
    ['graph-state', graphStateDocName],
    ['graph-groups', graphGroupsDocName],
  ])('should accept the %s doc for the caller\'s own group', async (_label, build) => {
    await expect(authenticate(build(OWN_GROUP))).resolves.toMatchObject({
      groupId: OWN_GROUP,
    });
  });

  it.each([
    ['presence', presenceDocName],
    ['graph-state', graphStateDocName],
    ['graph-groups', graphGroupsDocName],
  ])('should reject the %s doc of another group', async (_label, build) => {
    await expect(authenticate(build(OTHER_GROUP))).rejects.toThrow('Unauthorized');
  });

  it('should still reject the unprefixed presence name', async () => {
    await expect(authenticate(`.presence:${OWN_GROUP}`)).rejects.toThrow('Unauthorized');
  });
});
