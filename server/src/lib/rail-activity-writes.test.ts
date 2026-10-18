// Every write that bumps a note's `updated_at` must also stamp the
// acting user as `updated_by`. The rail's `latestActivityAt` skips the
// caller's own writes by that column, so a write that leaves it stale
// shows a user their own move as new activity and hides it from the
// note's previous author.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { clearAllData, createUser, DEFAULT_GROUP_ID as groupId } from './users';
import { buildSessionCookies, createSession } from './session';
import { listWorldsForSession } from './groups';
import { moveFolder } from './move-folder';
import { visibilityFor } from './notes';
import { createUserCharacter, updateUserCharacter } from './userCharacters';
import { POST as moveRoute } from '@/app/api/notes/move/route';
import { PATCH as tagsRoute } from '@/app/api/note-tags/route';

const TAVERN = 'Campaigns/Ashfall/Lore/tavern.md';
const INN = 'Campaigns/Ashfall/Lore/inn.md';
const MAP = 'Campaigns/Ashfall/Lore/map.md';
const BASELINE_AT = 500;
const BOBS_EDIT_AT = 1_000;

let alice: string;
let bob: string;

beforeAll(async () => {
  setupTestDb();
  clearAllData();
  alice = (await createUser({ username: 'alice', displayName: 'Alice', password: 'correct-horse-battery', role: 'admin' })).id;
  bob = (await createUser({ username: 'bob', displayName: 'Bob', password: 'correct-horse-battery', role: 'editor' })).id;
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  for (const table of ['user_character_bindings', 'user_characters', 'note_links', 'tags', 'notes', 'campaigns']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, 'ashfall', 'Ashfall', 'Campaigns/Ashfall', 1);
  seed('Lore/baseline.md', BASELINE_AT, bob);
});

function paragraph(content: unknown[]): string {
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content }] });
}

function seed(path: string, updatedAt: number, by: string, contentJson = paragraph([{ type: 'text', text: path }])): string {
  const id = randomUUID();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, frontmatter_json,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, '', '{}', ?, ?, ?, ?)`,
    )
    .run(id, groupId, path, path, contentJson, updatedAt, by, updatedAt, by);
  return id;
}

function latestFor(userId: string): number | null {
  const world = listWorldsForSession(userId, 'no-session').find((w) => w.id === groupId);
  if (!world) throw new Error('world missing from list');
  return world.latestActivityAt;
}

function aliceRequest(url: string, method: string, body: unknown): NextRequest {
  const session = createSession({ userId: alice, groupId, userAgent: null, ip: null });
  const cookie = buildSessionCookies(session).map((c) => `${c.name}=${c.value}`).join('; ');
  return new Request(`http://localhost${url}`, {
    method,
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** Bob last wrote the note(s); Alice's write must read as Bob's news,
 *  never as Alice's. */
async function expectAliceWriteCreditedToAlice(write: () => Promise<void> | void): Promise<void> {
  expect(latestFor(alice)).toBe(BOBS_EDIT_AT);
  const startedAt = Date.now();

  await write();

  expect(latestFor(alice)).toBe(BASELINE_AT);
  expect(latestFor(bob)).toBeGreaterThanOrEqual(startedAt);
}

describe('rail activity after a write by another member', () => {
  it("should credit a note move to the mover, not the note's last editor", async () => {
    seed(TAVERN, BOBS_EDIT_AT, bob);

    await expectAliceWriteCreditedToAlice(async () => {
      const res = await moveRoute(aliceRequest('/api/notes/move', 'POST', { from: TAVERN, to: INN }));
      expect(res.status).toBe(200);
    });
  });

  it('should credit a tag edit to the tagger', async () => {
    seed(TAVERN, BOBS_EDIT_AT, bob);

    await expectAliceWriteCreditedToAlice(async () => {
      const res = await tagsRoute(aliceRequest('/api/note-tags', 'PATCH', { path: TAVERN, tags: ['inn'] }));
      expect(res.status).toBe(200);
    });
  });

  it('should credit a folder move to the mover', async () => {
    seed('Places/tavern.md', BOBS_EDIT_AT, bob);

    await expectAliceWriteCreditedToAlice(async () => {
      const result = await moveFolder({ groupId, userId: alice, from: 'Places', to: 'Towns', vis: visibilityFor('admin') });
      expect(result.ok).toBe(true);
    });
  });

  it('should credit the wikilink rewrite in a linking note to the mover', async () => {
    seed(TAVERN, BASELINE_AT - 100, bob);
    seed(MAP, BOBS_EDIT_AT, bob, paragraph([{ type: 'wikilink', attrs: { target: TAVERN, label: 'Tavern' } }]));
    getDb()
      .query('INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)')
      .run(groupId, MAP, TAVERN);

    await expectAliceWriteCreditedToAlice(async () => {
      const res = await moveRoute(aliceRequest('/api/notes/move', 'POST', { from: TAVERN, to: INN }));
      expect(res.status).toBe(200);
    });
    const map = getDb()
      .query<{ content_json: string }, [string]>('SELECT content_json FROM notes WHERE path = ?')
      .get(MAP);
    expect(map?.content_json).toContain(INN);
  });

  it('should credit the campaign folder index refresh to the mover', async () => {
    seed('Campaigns/Ashfall/People/index.md', BOBS_EDIT_AT, bob, paragraph([{ type: 'text', text: 'People' }]));
    seed('Campaigns/Ashfall/People/volo.md', BASELINE_AT - 100, bob);

    await expectAliceWriteCreditedToAlice(async () => {
      const res = await moveRoute(
        aliceRequest('/api/notes/move', 'POST', {
          from: 'Campaigns/Ashfall/People/volo.md',
          to: 'Campaigns/Ashfall/People/volothamp.md',
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  it("should credit a character sync from /me to the character's owner", async () => {
    const character = createUserCharacter(alice, { name: 'Shadowheart' });
    const noteId = seed('Characters/shadowheart.md', BOBS_EDIT_AT, bob);
    getDb()
      .query(
        `INSERT INTO user_character_bindings (user_character_id, group_id, campaign_slug, note_id, joined_at)
         VALUES (?, ?, 'ashfall', ?, 1)`,
      )
      .run(character.id, groupId, noteId);

    await expectAliceWriteCreditedToAlice(() => {
      expect(updateUserCharacter(character.id, alice, { name: 'Shadowheart of Baldur' })).not.toBeNull();
    });
  });
});
