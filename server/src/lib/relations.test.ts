import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { RELATION_TYPES, type RelationType } from '@compendium/shared';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { clearAllData, createUser, DEFAULT_GROUP_ID as groupId } from '@/lib/users';
import { buildSessionCookies, createSession } from '@/lib/session';
import { moveFolder } from '@/lib/move-folder';
import { createTools } from '@/lib/ai/tools';
import { persistDerived } from '@/collab/derive';
import { POST as moveRoute } from '@/app/api/notes/move/route';
import { POST as promoteRoute } from '@/app/api/notes/promote/route';
import { POST as duplicateRoute } from '@/app/api/notes/duplicate/route';
import { DELETE as deleteNoteRoute } from '@/app/api/notes/[...path]/route';
import { POST as deleteFolderRoute } from '@/app/api/folders/delete/route';
import { POST as deleteCampaignRoute } from '@/app/api/campaigns/delete/route';
import type { PmDoc } from '@/lib/note-edits';
import { addRelation, listRelations } from './relations';

const VOLO = 'Campaigns/Ashfall/People/volo.md';
const XANATHAR = 'Campaigns/Ashfall/People/xanathar.md';
const GUILD = 'Campaigns/Ashfall/Lore/thieves-guild.md';
const SPY = 'Campaigns/Ashfall/People/spy.md';
const PLAN = 'Campaigns/Ashfall/People/owners-plan.md';
const SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-11-the-mill.md';
const SECRET_SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-12-the-vault.md';
const WATERDEEP = 'World Lore/waterdeep.md';

let ownerId: string;

function seed(path: string, title: string, opts: { dmOnly?: boolean; gmOnly?: boolean } = {}): void {
  const body: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `About ${title}.` }] }] };
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), body, 'default');
  ydoc.getText('title').insert(0, title);
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, '{}', 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(), groupId, path, title, JSON.stringify(body), `About ${title}.`,
      Y.encodeStateAsUpdate(ydoc), now, ownerId, now, ownerId, opts.dmOnly ? 1 : 0, opts.gmOnly ? 1 : 0,
    );
}

const relate = (from: string, relation: RelationType, to: string, sessionPath: string | null = SESSION) =>
  addRelation({ groupId, from, relation, to, sessionPath, userId: ownerId });

const read = (path: string, role: 'admin' | 'editor' | 'viewer' = 'admin') =>
  listRelations({ groupId, role, path }).map((r) => `${r.relation} ${r.path}`);

const storedRows = () =>
  getDb()
    .query<{ from_path: string; relation: string; to_path: string }, []>(
      'SELECT from_path, relation, to_path FROM note_relations ORDER BY from_path, relation, to_path',
    )
    .all();

const link = (from: string, to: string) =>
  getDb()
    .query<{ is_manual: number }, [string, string, string]>(
      'SELECT is_manual FROM note_links WHERE group_id = ? AND from_path = ? AND to_path = ?',
    )
    .get(groupId, from, to);

function ownerRequest(url: string, method: string, body?: unknown): NextRequest {
  const owner = createSession({ userId: ownerId, groupId, userAgent: null, ip: null });
  const cookie = buildSessionCookies(owner).map((c) => `${c.name}=${c.value}`).join('; ');
  return new Request(`http://localhost${url}`, {
    method,
    headers: { cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

beforeAll(async () => {
  setupTestDb();
  ownerId = (await createUser({ username: 'owner', displayName: 'owner', password: 'correct-horse-battery', role: 'admin' })).id;
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  for (const table of ['note_relations', 'note_links', 'tags', 'notes', 'campaigns', 'folder_markers']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, 'ashfall', 'Ashfall', 'Campaigns/Ashfall', Date.now());
  seed(VOLO, 'Volo');
  seed(XANATHAR, 'Xanathar');
  seed(GUILD, 'Thieves Guild');
  seed(SPY, 'The Spy', { dmOnly: true });
  seed(PLAN, "The Owner's Plan", { gmOnly: true });
  seed(SESSION, 'The Mill');
  seed(SECRET_SESSION, 'The Vault', { dmOnly: true });
  seed(WATERDEEP, 'Waterdeep');
});

describe('addRelation', () => {
  it('adds a Relationship once and reports a repeat as unchanged', () => {
    expect(relate(VOLO, 'works_for', XANATHAR)).toEqual({ status: 'added' });
    expect(relate(VOLO, 'works_for', XANATHAR)).toEqual({ status: 'unchanged' });

    expect(read(VOLO)).toEqual([`works_for ${XANATHAR}`]);
  });

  it('stores a symmetric Relationship once, whichever end it is added from', () => {
    relate(XANATHAR, 'enemy_of', VOLO);

    expect(relate(VOLO, 'enemy_of', XANATHAR)).toEqual({ status: 'unchanged' });
    expect(storedRows()).toEqual([{ from_path: VOLO, relation: 'enemy_of', to_path: XANATHAR }]);
  });

  it('keeps two different Relationships between the same pair', () => {
    relate(VOLO, 'ally_of', XANATHAR);
    relate(VOLO, 'works_for', XANATHAR);

    expect(read(VOLO)).toEqual([`ally_of ${XANATHAR}`, `works_for ${XANATHAR}`]);
  });

  it('adds the manual link between the two Notes', () => {
    relate(VOLO, 'member_of', GUILD);

    expect(link(VOLO, GUILD)).toEqual({ is_manual: 1 });
  });

  it('keeps the link when an edit removes the wikilink the body already had', () => {
    getDb()
      .query('INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)')
      .run(groupId, VOLO, GUILD);
    relate(VOLO, 'member_of', GUILD);

    getDb().transaction(() => {
      persistDerived({
        groupId,
        path: VOLO,
        userId: ownerId,
        derived: {
          title: 'Volo',
          pmJson: { type: 'doc', content: [] },
          contentText: '',
          contentMd: '',
          wikilinks: [],
          inlineTags: [],
        },
      });
    })();

    expect(link(VOLO, GUILD)).toEqual({ is_manual: 1 });
  });

  it('can store every shared type, so the CHECK matches the shared list', () => {
    for (const type of RELATION_TYPES) {
      expect(relate(VOLO, type, XANATHAR)).toEqual({ status: 'added' });
    }
  });

  it('leaves the table refusing a type outside the shared list', () => {
    const insert = () =>
      getDb()
        .query(
          `INSERT INTO note_relations (group_id, from_path, relation, to_path, created_at)
           VALUES (?, ?, 'rivals_with', ?, ?)`,
        )
        .run(groupId, VOLO, XANATHAR, Date.now());

    expect(insert).toThrow();
  });

  it('refuses a Note related to itself', () => {
    expect(() => relate(VOLO, 'related_to', VOLO)).toThrow();
  });
});

describe('listRelations', () => {
  it('reads the inverse from the other end', () => {
    relate(VOLO, 'member_of', GUILD);

    expect(listRelations({ groupId, role: 'viewer', path: GUILD })).toEqual([
      expect.objectContaining({ relation: 'has_member', label: 'has member', path: VOLO, title: 'Volo', sessionPath: SESSION }),
    ]);
    expect(listRelations({ groupId, role: 'viewer', path: VOLO })).toEqual([
      expect.objectContaining({ relation: 'member_of', label: 'member of', path: GUILD, title: 'Thieves Guild' }),
    ]);
  });

  it('reads a symmetric type the same way from both ends', () => {
    relate(VOLO, 'ally_of', XANATHAR);

    expect(read(VOLO)).toEqual([`ally_of ${XANATHAR}`]);
    expect(read(XANATHAR)).toEqual([`ally_of ${VOLO}`]);
  });

  it('hides a Relationship with a Secret Note from a Player but not a Co-GM', () => {
    relate(VOLO, 'works_for', XANATHAR);
    relate(SPY, 'works_for', VOLO);

    expect(read(VOLO, 'viewer')).toEqual([`works_for ${XANATHAR}`]);
    expect(read(VOLO, 'editor')).toEqual([`employs ${SPY}`, `works_for ${XANATHAR}`]);
    expect(read(SPY, 'viewer')).toEqual([]);
  });

  it('hides a Relationship with a Private Note from a Co-GM but not the Owner', () => {
    relate(PLAN, 'related_to', VOLO);

    expect(read(VOLO, 'editor')).toEqual([]);
    expect(read(VOLO, 'admin')).toEqual([`related_to ${PLAN}`]);
  });

  it('withholds a Secret Session from a Player and shows it to a Co-GM', () => {
    relate(VOLO, 'works_for', XANATHAR, SECRET_SESSION);

    expect(listRelations({ groupId, role: 'viewer', path: VOLO })[0]?.sessionPath).toBeNull();
    expect(listRelations({ groupId, role: 'editor', path: VOLO })[0]?.sessionPath).toBe(SECRET_SESSION);
  });
});

describe('renaming or moving a Note', () => {
  const NEW_VOLO = 'Campaigns/Ashfall/People/volo-geddarm.md';

  const move = async (from: string, to: string) => {
    const res = await moveRoute(ownerRequest('/api/notes/move', 'POST', { from, to }));
    expect(res.status).toBe(200);
  };

  it('carries its Relationships, both ends, to the new path', async () => {
    relate(VOLO, 'works_for', XANATHAR);
    relate(SPY, 'works_for', VOLO);

    await move(VOLO, NEW_VOLO);

    expect(read(VOLO)).toEqual([]);
    expect(read(NEW_VOLO)).toEqual([`employs ${SPY}`, `works_for ${XANATHAR}`]);
    expect(read(XANATHAR)).toEqual([`employs ${NEW_VOLO}`]);
  });

  it('carries the Session a Relationship was established in', async () => {
    const NEW_SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-11-the-old-mill.md';
    relate(VOLO, 'works_for', XANATHAR);

    await move(SESSION, NEW_SESSION);

    expect(listRelations({ groupId, role: 'viewer', path: VOLO })[0]?.sessionPath).toBe(NEW_SESSION);
  });

  it('merges into a Relationship already recorded at the new path', async () => {
    relate(VOLO, 'works_for', XANATHAR);
    getDb()
      .query(
        `INSERT INTO note_relations (group_id, from_path, relation, to_path, created_at)
         VALUES (?, ?, 'works_for', ?, ?)`,
      )
      .run(groupId, NEW_VOLO, XANATHAR, Date.now());

    await move(VOLO, NEW_VOLO);

    expect(storedRows()).toEqual([{ from_path: NEW_VOLO, relation: 'works_for', to_path: XANATHAR }]);
  });

  it('drops a Relationship that joined the Note to its new path', async () => {
    getDb()
      .query(
        `INSERT INTO note_relations (group_id, from_path, relation, to_path, created_at)
         VALUES (?, ?, 'works_for', ?, ?)`,
      )
      .run(groupId, VOLO, NEW_VOLO, Date.now());

    await move(VOLO, NEW_VOLO);

    expect(storedRows()).toEqual([]);
  });

  it('re-sorts a symmetric Relationship whose order the new path changes', async () => {
    const A_XANATHAR = 'Campaigns/Ashfall/Lore/a-xanathar.md';
    relate(VOLO, 'ally_of', XANATHAR);

    await move(XANATHAR, A_XANATHAR);

    expect(relate(VOLO, 'ally_of', A_XANATHAR)).toEqual({ status: 'unchanged' });
    expect(storedRows()).toEqual([{ from_path: A_XANATHAR, relation: 'ally_of', to_path: VOLO }]);
  });

  it('carries them when the folder holding the Note is renamed', async () => {
    relate(VOLO, 'member_of', GUILD);

    const moved = await moveFolder({ groupId, userId: ownerId, from: 'Campaigns/Ashfall/People', to: 'Campaigns/Ashfall/Folk' });

    expect(moved.ok).toBe(true);
    expect(read(GUILD)).toEqual(['has_member Campaigns/Ashfall/Folk/volo.md']);
  });

  it('carries them when the AI moves the Note', async () => {
    relate(VOLO, 'member_of', GUILD);
    const tools = createTools({ groupId, userId: ownerId, role: 'dm', sessionRole: 'admin', gmNamespace: true });

    const result = await tools.entity_move.execute!({ from: VOLO, to: NEW_VOLO }, { toolCallId: 't1', messages: [] });

    expect((result as { ok: boolean }).ok).toBe(true);
    expect(read(GUILD)).toEqual([`has_member ${NEW_VOLO}`]);
  });

  it('carries them when the AI changes the Note kind and so its folder', async () => {
    relate(VOLO, 'member_of', GUILD);
    const tools = createTools({ groupId, userId: ownerId, role: 'dm', sessionRole: 'admin', gmNamespace: true });

    const result = (await tools.entity_change_kind.execute!(
      { path: VOLO, newKind: 'creature' },
      { toolCallId: 't1', messages: [] },
    )) as { ok: boolean; path: string };

    expect(result.ok).toBe(true);
    expect(result.path).not.toBe(VOLO);
    expect(read(GUILD)).toEqual([`has_member ${result.path}`]);
  });

  it('carries them when a Private Note is revealed by moving it', async () => {
    const REVEALED = 'Campaigns/Ashfall/People/the-plan.md';
    relate(PLAN, 'related_to', VOLO);

    const res = await promoteRoute(
      ownerRequest('/api/notes/promote', 'POST', { fromPath: PLAN, toPath: REVEALED, mode: 'move' }),
    );

    expect(res.status).toBe(200);
    expect(read(VOLO, 'viewer')).toEqual([`related_to ${REVEALED}`]);
  });
});

describe('deleting a Note', () => {
  it('drops its Relationships', async () => {
    relate(VOLO, 'works_for', XANATHAR);
    relate(VOLO, 'member_of', GUILD);

    const res = await deleteNoteRoute(ownerRequest(`/api/notes/${VOLO}`, 'DELETE'), {
      params: Promise.resolve({ path: VOLO.split('/') }),
    });

    expect(res.status).toBe(200);
    expect(storedRows()).toEqual([]);
  });

  it('forgets a deleted Session behind the Relationships it established', async () => {
    relate(VOLO, 'works_for', XANATHAR);

    await deleteNoteRoute(ownerRequest(`/api/notes/${SESSION}`, 'DELETE'), {
      params: Promise.resolve({ path: SESSION.split('/') }),
    });
    seed(SESSION, 'A Different Mill');

    expect(listRelations({ groupId, role: 'admin', path: VOLO })[0]?.sessionPath).toBeNull();
  });

  it('drops the Relationships of every Note in a deleted folder', async () => {
    relate(VOLO, 'member_of', GUILD);
    relate(GUILD, 'located_in', WATERDEEP);

    const res = await deleteFolderRoute(ownerRequest('/api/folders/delete', 'POST', { path: 'Campaigns/Ashfall/People' }));

    expect(res.status).toBe(200);
    expect(storedRows()).toEqual([{ from_path: GUILD, relation: 'located_in', to_path: WATERDEEP }]);
  });

  it('drops the Relationships of every Note in a deleted Campaign', async () => {
    relate(GUILD, 'located_in', WATERDEEP);

    const res = await deleteCampaignRoute(ownerRequest('/api/campaigns/delete', 'POST', { slug: 'ashfall' }));

    expect(res.status).toBe(200);
    expect(storedRows()).toEqual([]);
  });

  it('drops every Relationship in a deleted World', () => {
    const world = randomUUID();
    getDb().query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(world, 'Elsewhere', Date.now());
    addRelation({ groupId: world, from: 'a.md', relation: 'ally_of', to: 'b.md', sessionPath: null, userId: null });

    getDb().query('DELETE FROM groups WHERE id = ?').run(world);

    expect(storedRows()).toEqual([]);
  });
});

describe('duplicating a Note', () => {
  it('gives the copy no Relationships', async () => {
    relate(VOLO, 'works_for', XANATHAR);

    const res = await duplicateRoute(ownerRequest('/api/notes/duplicate', 'POST', { path: VOLO }));
    const { path: copy } = (await res.json()) as { path: string };

    expect(res.status).toBe(201);
    expect(read(copy)).toEqual([]);
    expect(read(VOLO)).toEqual([`works_for ${XANATHAR}`]);
  });
});

describe('clearing all data', () => {
  it('wipes every Relationship', () => {
    relate(VOLO, 'works_for', XANATHAR);

    clearAllData();

    expect(storedRows()).toEqual([]);
  });
});
