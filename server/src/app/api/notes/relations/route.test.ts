import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { listRelations } from '@/lib/relations';
import { DELETE, POST } from './route';

const VOLO = 'Campaigns/Ashfall/People/volo.md';
const GUILD = 'Campaigns/Ashfall/Lore/thieves-guild.md';
const RIVAL = 'Campaigns/Ashfall/People/rival.md';
const SECRET = 'Campaigns/Ashfall/People/spy.md';
const MINE = 'Campaigns/Ashfall/People/pats-hero.md';
const MINE_TOO = 'Campaigns/Ashfall/Lore/pats-town.md';

let gm: Session;
let pat: Session;
let patId: string;

async function sessionFor(username: string, role: 'editor' | 'viewer'): Promise<{ session: Session; id: string }> {
  const user = await createUser({ username, displayName: username, password: 'correct-horse-battery', role });
  return {
    id: user.id,
    session: createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null }),
  };
}

function call(method: 'POST' | 'DELETE', as: Session, body: unknown): NextRequest {
  const cookie = buildSessionCookies(as)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request('http://localhost/api/notes/relations', {
    method,
    headers: { cookie, 'x-csrf-token': as.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const add = (as: Session, path: string, relation: string, otherPath: string) =>
  POST(call('POST', as, { path, relation, otherPath }));
const remove = (as: Session, path: string, relation: string, otherPath: string) =>
  DELETE(call('DELETE', as, { path, relation, otherPath }));

function seed(path: string, createdBy: string, opts: { dmOnly?: boolean } = {}): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, '{}', 0, ?, ?, ?, ?, ?, 0)`,
    )
    .run(randomUUID(), DEFAULT_GROUP_ID, path, path, now, createdBy, now, createdBy, opts.dmOnly ? 1 : 0);
}

const stored = () =>
  getDb()
    .query<{ from_path: string; relation: string; to_path: string; session_path: string | null; created_by: string | null }, []>(
      'SELECT from_path, relation, to_path, session_path, created_by FROM note_relations ORDER BY from_path, relation, to_path',
    )
    .all();

const linkRow = (from: string, to: string) =>
  getDb()
    .query<{ is_manual: number }, [string, string, string]>(
      'SELECT is_manual FROM note_links WHERE group_id = ? AND from_path = ? AND to_path = ?',
    )
    .get(DEFAULT_GROUP_ID, from, to);

const audits = (action: string) =>
  getDb()
    .query<{ actor_id: string; details_json: string }, [string]>(
      'SELECT actor_id, details_json FROM audit_log WHERE action = ? ORDER BY at',
    )
    .all(action)
    .map((r) => ({ actor: r.actor_id, details: JSON.parse(r.details_json) as unknown }));

beforeAll(async () => {
  setupTestDb();
  const g = await sessionFor('cogm', 'editor');
  gm = g.session;
  const p = await sessionFor('pat', 'viewer');
  pat = p.session;
  patId = p.id;
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  for (const t of ['note_relations', 'note_links', 'audit_log', 'notes']) db.exec(`DELETE FROM ${t}`);
  seed(VOLO, gm.userId);
  seed(GUILD, gm.userId);
  seed(RIVAL, gm.userId);
  seed(SECRET, gm.userId, { dmOnly: true });
  seed(MINE, patId);
  seed(MINE_TOO, patId);
});

describe('POST /api/notes/relations', () => {
  it('adds a forward type, with its plain link, and records the caller', async () => {
    const res = await add(gm, VOLO, 'works_for', GUILD);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, status: 'added' });
    expect(stored()).toEqual([
      { from_path: VOLO, relation: 'works_for', to_path: GUILD, session_path: null, created_by: gm.userId },
    ]);
    expect(linkRow(VOLO, GUILD)).toEqual({ is_manual: 1 });
  });

  it('stores an inverse name as the canonical forward row', async () => {
    const res = await add(gm, GUILD, 'employs', VOLO);

    expect(res.status).toBe(201);
    expect(stored().map((r) => `${r.from_path} ${r.relation} ${r.to_path}`)).toEqual([
      `${VOLO} works_for ${GUILD}`,
    ]);
    expect(listRelations({ groupId: DEFAULT_GROUP_ID, role: 'editor', path: GUILD })[0]?.relation).toBe('employs');
  });

  it("'link' inserts only the plain manual link", async () => {
    const res = await add(gm, VOLO, 'link', GUILD);

    expect(res.status).toBe(201);
    expect(stored()).toEqual([]);
    expect(linkRow(VOLO, GUILD)).toEqual({ is_manual: 1 });
    expect(linkRow(GUILD, VOLO) ?? null).toBeNull();
  });

  it("'link' flips an existing body-derived link to manual", async () => {
    getDb()
      .query('INSERT INTO note_links (group_id, from_path, to_path, is_manual) VALUES (?, ?, ?, 0)')
      .run(DEFAULT_GROUP_ID, VOLO, GUILD);

    const res = await add(gm, VOLO, 'link', GUILD);

    expect(res.status).toBe(201);
    expect(linkRow(VOLO, GUILD)).toEqual({ is_manual: 1 });
    expect((await add(gm, VOLO, 'link', GUILD)).status).toBe(200);
  });

  it('adding a symmetric type from the other end is unchanged', async () => {
    await add(gm, VOLO, 'enemy_of', RIVAL);

    const again = await add(gm, RIVAL, 'enemy_of', VOLO);

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, status: 'unchanged' });
    expect(stored()).toHaveLength(1);
    expect(audits('relation.add')).toHaveLength(1);
  });

  it('writes an audit row naming the stored form', async () => {
    await add(gm, GUILD, 'employs', VOLO);

    expect(audits('relation.add')).toEqual([
      { actor: gm.userId, details: { from: VOLO, relation: 'works_for', to: GUILD } },
    ]);
  });

  it('refuses a Player who did not create one of the Notes', async () => {
    const res = await add(pat, MINE, 'related_to', VOLO);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('forbidden');
    expect(stored()).toEqual([]);
  });

  it('lets a Player connect two Notes they created', async () => {
    const res = await add(pat, MINE, 'located_in', MINE_TOO);

    expect(res.status).toBe(201);
    expect(stored()).toHaveLength(1);
  });

  it('answers 404, never 403, for a Note hidden from the caller or missing', async () => {
    const hidden = await add(pat, MINE, 'related_to', SECRET);
    const missing = await add(pat, MINE, 'related_to', 'Nope/missing.md');

    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(((await hidden.json()) as { error: string }).error).toBe('not_found');
    expect(stored()).toEqual([]);
  });

  it('rejects an unknown relation and a self connection', async () => {
    expect((await add(gm, VOLO, 'friends_with', GUILD)).status).toBe(400);
    expect((await add(gm, VOLO, 'ally_of', VOLO)).status).toBe(400);
  });
});

describe('DELETE /api/notes/relations', () => {
  it('removes the Relationship and keeps the plain link', async () => {
    await add(gm, VOLO, 'works_for', GUILD);

    const res = await remove(gm, GUILD, 'employs', VOLO);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'removed' });
    expect(stored()).toEqual([]);
    expect(linkRow(VOLO, GUILD)).toEqual({ is_manual: 1 });
    expect(audits('relation.remove')).toEqual([
      { actor: gm.userId, details: { from: VOLO, relation: 'works_for', to: GUILD } },
    ]);
  });

  it('reports a Relationship that is not there as 404 and writes no audit row', async () => {
    const res = await remove(gm, VOLO, 'works_for', GUILD);

    expect(res.status).toBe(404);
    expect(audits('relation.remove')).toEqual([]);
  });

  it('applies the same edit rule and hides hidden Notes', async () => {
    await add(gm, VOLO, 'works_for', GUILD);

    expect((await remove(pat, VOLO, 'works_for', GUILD)).status).toBe(403);
    expect((await remove(pat, VOLO, 'works_for', SECRET)).status).toBe(404);
    expect(stored()).toHaveLength(1);
  });
});
