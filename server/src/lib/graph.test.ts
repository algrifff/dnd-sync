import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { buildGraph, buildNeighborhood, listVisibleCampaignNames } from './graph';
import { setupTestDb, teardownTestDb } from './test-utils';
import { DEFAULT_GROUP_ID } from './users';

// ── Test helpers ───────────────────────────────────────────────────────

function seedNote(
  groupId: string,
  path: string,
  flags: { dmOnly?: boolean; gmOnly?: boolean; frontmatter?: string } = {},
): string {
  const id = randomUUID();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, content_json, content_text,
                          title, updated_at, dm_only, gm_only, frontmatter_json)
       VALUES (?, ?, ?, '{}', '', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      groupId,
      path,
      path,
      Date.now(),
      flags.dmOnly ? 1 : 0,
      flags.gmOnly ? 1 : 0,
      flags.frontmatter ?? '{}',
    );
  return id;
}

function seedTag(groupId: string, path: string, tag: string): void {
  getDb()
    .query(`INSERT INTO tags (group_id, path, tag) VALUES (?, ?, ?)`)
    .run(groupId, path, tag);
}

function seedRelation(groupId: string, from: string, relation: string, to: string): void {
  getDb()
    .query(
      `INSERT INTO note_relations (group_id, from_path, relation, to_path, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(groupId, from, relation, to, Date.now());
}

function seedLink(groupId: string, fromPath: string, toPath: string): void {
  getDb()
    .query(`INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)`)
    .run(groupId, fromPath, toPath);
}

// ── DB setup ───────────────────────────────────────────────────────────

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM note_relations');
  db.exec('DELETE FROM note_links');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM notes');
});

// ── buildGraph — dm_only filtering, all three scopes ────────────────────

describe('buildGraph — hideDmOnly (kind: all)', () => {
  const plain = 'vault/plain.md';
  const dmNote = 'vault/dm.md';

  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, plain);
    seedNote(DEFAULT_GROUP_ID, dmNote, { dmOnly: true });
    seedLink(DEFAULT_GROUP_ID, plain, dmNote);
  });

  it('omits a dm_only node when hideDmOnly is true', () => {
    const payload = buildGraph(DEFAULT_GROUP_ID, { kind: 'all' }, { hideDmOnly: true });
    expect(payload.nodes.map((n) => n.id)).not.toContain(dmNote);
  });

  it('omits edges touching a hidden dm_only node', () => {
    const payload = buildGraph(DEFAULT_GROUP_ID, { kind: 'all' }, { hideDmOnly: true });
    expect(payload.edges).toHaveLength(0);
  });

  it('still returns the dm_only node when hideDmOnly is false', () => {
    const payload = buildGraph(DEFAULT_GROUP_ID, { kind: 'all' }, { hideDmOnly: false });
    expect(payload.nodes.map((n) => n.id)).toContain(dmNote);
  });
});

describe('buildGraph — hideDmOnly (kind: folder)', () => {
  const plain = 'vault/folder/plain.md';
  const dmNote = 'vault/folder/dm.md';

  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, plain);
    seedNote(DEFAULT_GROUP_ID, dmNote, { dmOnly: true });
  });

  it('omits a dm_only node under the folder scope', () => {
    const payload = buildGraph(
      DEFAULT_GROUP_ID,
      { kind: 'folder', path: 'vault/folder' },
      { hideDmOnly: true },
    );
    expect(payload.nodes.map((n) => n.id)).not.toContain(dmNote);
    expect(payload.nodes.map((n) => n.id)).toContain(plain);
  });
});

describe('buildGraph — hideDmOnly (kind: tag)', () => {
  // The tag-scope query aliases `notes` as `n` — a copy-paste of the
  // unaliased clause here would be a SQL error, and an omission would
  // be a silent leak. Test explicitly.
  const plain = 'vault/tagged-plain.md';
  const dmNote = 'vault/tagged-dm.md';

  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, plain);
    seedNote(DEFAULT_GROUP_ID, dmNote, { dmOnly: true });
    seedTag(DEFAULT_GROUP_ID, plain, 'adventure');
    seedTag(DEFAULT_GROUP_ID, dmNote, 'adventure');
  });

  it('omits a dm_only node under the tag scope', () => {
    const payload = buildGraph(
      DEFAULT_GROUP_ID,
      { kind: 'tag', tag: 'adventure' },
      { hideDmOnly: true },
    );
    expect(payload.nodes.map((n) => n.id)).not.toContain(dmNote);
    expect(payload.nodes.map((n) => n.id)).toContain(plain);
  });

  it('still returns the dm_only node under the tag scope when not hidden', () => {
    const payload = buildGraph(
      DEFAULT_GROUP_ID,
      { kind: 'tag', tag: 'adventure' },
      { hideDmOnly: false },
    );
    expect(payload.nodes.map((n) => n.id)).toContain(dmNote);
  });
});

// ── buildGraph — gm_only namespace selection is unchanged ───────────────

describe('buildGraph — gm_only namespace unaffected by hideDmOnly', () => {
  const playerNote = 'vault/player.md';
  const gmNote = 'vault/gm.md';

  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, playerNote);
    seedNote(DEFAULT_GROUP_ID, gmNote, { gmOnly: true });
  });

  it('mode: player returns only gm_only=0 notes, regardless of hideDmOnly', () => {
    for (const hideDmOnly of [true, false]) {
      const payload = buildGraph(DEFAULT_GROUP_ID, { kind: 'all' }, { mode: 'player', hideDmOnly });
      expect(payload.nodes.map((n) => n.id)).toContain(playerNote);
      expect(payload.nodes.map((n) => n.id)).not.toContain(gmNote);
    }
  });

  it('mode: gm returns only gm_only=1 notes, regardless of hideDmOnly', () => {
    for (const hideDmOnly of [true, false]) {
      const payload = buildGraph(DEFAULT_GROUP_ID, { kind: 'all' }, { mode: 'gm', hideDmOnly });
      expect(payload.nodes.map((n) => n.id)).toContain(gmNote);
      expect(payload.nodes.map((n) => n.id)).not.toContain(playerNote);
    }
  });
});

// ── buildGraph — etag ────────────────────────────────────────────────────

describe('buildGraph — etag', () => {
  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, 'vault/a.md');
  });

  it('differs between hideDmOnly true and false on identical input', () => {
    const withHide = buildGraph(DEFAULT_GROUP_ID, { kind: 'all' }, { hideDmOnly: true });
    const withoutHide = buildGraph(DEFAULT_GROUP_ID, { kind: 'all' }, { hideDmOnly: false });
    expect(withHide.etag).not.toBe(withoutHide.etag);
  });
});

// ── buildNeighborhood — dm_only filtering ───────────────────────────────

describe('buildNeighborhood — hideDmOnly', () => {
  const center = 'vault/center.md';
  const dmNeighbour = 'vault/dm-neighbour.md';
  const plainNeighbour = 'vault/plain-neighbour.md';

  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, center);
    seedNote(DEFAULT_GROUP_ID, dmNeighbour, { dmOnly: true });
    seedNote(DEFAULT_GROUP_ID, plainNeighbour);
    seedLink(DEFAULT_GROUP_ID, center, dmNeighbour);
    seedLink(DEFAULT_GROUP_ID, center, plainNeighbour);
  });

  it('returns null when the center note is dm_only and hideDmOnly is true', () => {
    seedNote(DEFAULT_GROUP_ID, 'vault/dm-center.md', { dmOnly: true });
    const payload = buildNeighborhood(DEFAULT_GROUP_ID, 'vault/dm-center.md', 1, {
      hideDmOnly: true,
    });
    expect(payload).toBeNull();
  });

  it('omits a dm_only neighbour from nodes when hideDmOnly is true', () => {
    const payload = buildNeighborhood(DEFAULT_GROUP_ID, center, 1, { hideDmOnly: true });
    expect(payload).not.toBeNull();
    expect(payload!.nodes.map((n) => n.id)).not.toContain(dmNeighbour);
    expect(payload!.nodes.map((n) => n.id)).toContain(plainNeighbour);
  });

  it('includes the dm_only neighbour when hideDmOnly is false', () => {
    const payload = buildNeighborhood(DEFAULT_GROUP_ID, center, 1, { hideDmOnly: false });
    expect(payload!.nodes.map((n) => n.id)).toContain(dmNeighbour);
  });

  it('differs in etag between hideDmOnly true and false', () => {
    const withHide = buildNeighborhood(DEFAULT_GROUP_ID, center, 1, { hideDmOnly: true });
    const withoutHide = buildNeighborhood(DEFAULT_GROUP_ID, center, 1, { hideDmOnly: false });
    expect(withHide!.etag).not.toBe(withoutHide!.etag);
  });
});

// ── buildNeighborhood — frontier cannot route through a hidden note ──────
//
// D3 regression: the BFS frontier expansion used to query note_links with
// no visibility predicate, so a note reachable ONLY through a dm_only note
// would still surface as a depth-2 neighbour — an unexplainable orphan
// node that leaks the hidden note's existence and adjacency even though
// its own title/body stay hidden. The fix joins `notes` (with the same
// gm_only/dm_only predicate as the root lookup) into both hop queries.

describe('buildNeighborhood — frontier cannot traverse through a hidden note', () => {
  const center = 'vault/frontier-center.md';
  const dmGate = 'vault/frontier-dm-gate.md';
  const behindDmGate = 'vault/frontier-behind-dm-gate.md';

  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, center);
    seedNote(DEFAULT_GROUP_ID, dmGate, { dmOnly: true });
    seedNote(DEFAULT_GROUP_ID, behindDmGate);
    // The only path from center to behindDmGate runs through dmGate.
    seedLink(DEFAULT_GROUP_ID, center, dmGate);
    seedLink(DEFAULT_GROUP_ID, dmGate, behindDmGate);
  });

  it('excludes both the hidden gate and the note only reachable through it, at depth 2, for a viewer', () => {
    const payload = buildNeighborhood(DEFAULT_GROUP_ID, center, 2, { hideDmOnly: true });
    expect(payload).not.toBeNull();
    const ids = payload!.nodes.map((n) => n.id);
    expect(ids).not.toContain(dmGate);
    expect(ids).not.toContain(behindDmGate);
  });

  it('includes both the gate and the note behind it at depth 2 when not hidden (admin/editor)', () => {
    const payload = buildNeighborhood(DEFAULT_GROUP_ID, center, 2, { hideDmOnly: false });
    expect(payload).not.toBeNull();
    const ids = payload!.nodes.map((n) => n.id);
    expect(ids).toContain(dmGate);
    expect(ids).toContain(behindDmGate);
  });
});

// ── node metadata ───────────────────────────────────────────────────────

describe('buildGraph — kind / campaign / isIndex', () => {
  it('derives each field from frontmatter and path', () => {
    seedNote(DEFAULT_GROUP_ID, 'Campaigns/ember/Characters/Mira.md', { frontmatter: '{"kind":"pc"}' });
    seedNote(DEFAULT_GROUP_ID, 'Campaigns/ember/index.md');
    seedNote(DEFAULT_GROUP_ID, 'World Lore/README.md', { frontmatter: '{"kind":"nonsense"}' });
    seedNote(DEFAULT_GROUP_ID, 'loose.md', { frontmatter: '{"kind":42}' });

    const payload = buildGraph(DEFAULT_GROUP_ID, { kind: 'all' }, { hideDmOnly: false });
    const byId = new Map(payload.nodes.map((n) => [n.id, n]));

    expect(byId.get('Campaigns/ember/Characters/Mira.md')).toMatchObject({
      kind: 'character',
      campaign: 'ember',
      isIndex: false,
    });
    expect(byId.get('Campaigns/ember/index.md')).toMatchObject({
      kind: 'note',
      campaign: 'ember',
      isIndex: true,
    });
    expect(byId.get('World Lore/README.md')).toMatchObject({
      kind: 'note',
      campaign: null,
      isIndex: true,
    });
    expect(byId.get('loose.md')).toMatchObject({ kind: 'note', campaign: null, isIndex: false });
  });
});

// ── relations ───────────────────────────────────────────────────────────

describe('buildGraph — relations', () => {
  const a = 'vault/a.md';
  const b = 'vault/b.md';
  const all = { kind: 'all' } as const;

  it('includes a relation when both ends are visible', () => {
    seedNote(DEFAULT_GROUP_ID, a);
    seedNote(DEFAULT_GROUP_ID, b);
    seedRelation(DEFAULT_GROUP_ID, a, 'member_of', b);

    const payload = buildGraph(DEFAULT_GROUP_ID, all, { hideDmOnly: true });

    expect(payload.relations).toEqual([{ source: a, target: b, relation: 'member_of' }]);
  });

  it('hides it from a viewer when either end is dm_only, but not from a GM', () => {
    seedNote(DEFAULT_GROUP_ID, a, { dmOnly: true });
    seedNote(DEFAULT_GROUP_ID, b);
    seedNote(DEFAULT_GROUP_ID, 'vault/c.md');
    seedRelation(DEFAULT_GROUP_ID, a, 'leads', b);
    seedRelation(DEFAULT_GROUP_ID, 'vault/c.md', 'owns', a);

    expect(buildGraph(DEFAULT_GROUP_ID, all, { hideDmOnly: true }).relations).toEqual([]);
    expect(buildGraph(DEFAULT_GROUP_ID, all, { hideDmOnly: false }).relations).toHaveLength(2);
  });

  it('hides it from an editor when an end is gm_only', () => {
    seedNote(DEFAULT_GROUP_ID, a, { gmOnly: true });
    seedNote(DEFAULT_GROUP_ID, b);
    seedRelation(DEFAULT_GROUP_ID, a, 'leads', b);

    const payload = buildGraph(DEFAULT_GROUP_ID, all, { mode: 'player', hideDmOnly: false });

    expect(payload.relations).toEqual([]);
  });

  it('drops a relation with an end outside the requested scope', () => {
    seedNote(DEFAULT_GROUP_ID, 'in/a.md');
    seedNote(DEFAULT_GROUP_ID, 'out/b.md');
    seedRelation(DEFAULT_GROUP_ID, 'in/a.md', 'ally_of', 'out/b.md');

    const scoped = buildGraph(DEFAULT_GROUP_ID, { kind: 'folder', path: 'in' }, { hideDmOnly: false });

    expect(scoped.relations).toEqual([]);
  });

  it('changes the etag when a relation is added', () => {
    seedNote(DEFAULT_GROUP_ID, a);
    seedNote(DEFAULT_GROUP_ID, b);
    const before = buildGraph(DEFAULT_GROUP_ID, all, { hideDmOnly: false }).etag;

    seedRelation(DEFAULT_GROUP_ID, a, 'ally_of', b);

    expect(buildGraph(DEFAULT_GROUP_ID, all, { hideDmOnly: false }).etag).not.toBe(before);
  });
});

describe('buildNeighborhood — relations', () => {
  it('includes relations among the returned nodes and omits ones to nodes outside', () => {
    seedNote(DEFAULT_GROUP_ID, 'v/center.md');
    seedNote(DEFAULT_GROUP_ID, 'v/near.md');
    seedNote(DEFAULT_GROUP_ID, 'v/far.md');
    seedLink(DEFAULT_GROUP_ID, 'v/center.md', 'v/near.md');
    seedRelation(DEFAULT_GROUP_ID, 'v/center.md', 'ally_of', 'v/near.md');
    seedRelation(DEFAULT_GROUP_ID, 'v/center.md', 'enemy_of', 'v/far.md');

    const payload = buildNeighborhood(DEFAULT_GROUP_ID, 'v/center.md', 1, { hideDmOnly: false });

    expect(payload!.relations).toEqual([
      { source: 'v/center.md', target: 'v/near.md', relation: 'ally_of' },
    ]);
  });
});

// ── listVisibleCampaignNames ───────────────────────────────────────────

describe('listVisibleCampaignNames', () => {
  const G = DEFAULT_GROUP_ID;
  function seedCampaign(slug: string, name: string): void {
    getDb()
      .query(
        `INSERT OR REPLACE INTO campaigns (group_id, slug, name, folder_path, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(G, slug, name, `Campaigns/${slug}`, Date.now());
  }

  beforeEach(() => {
    getDb().exec('DELETE FROM campaigns');
    seedCampaign('open', 'The Open One');
    seedCampaign('secret', 'The Secret One');
    seedNote(G, 'Campaigns/open/Characters/A.md');
    seedNote(G, 'Campaigns/secret/Characters/B.md', { dmOnly: true });
  });

  it('names a campaign that has a visible note', () => {
    expect(listVisibleCampaignNames(G, { hideDmOnly: true }).open).toBe('The Open One');
  });

  it('leaves out a campaign whose only notes are hidden from the caller', () => {
    expect(Object.keys(listVisibleCampaignNames(G, { hideDmOnly: true }))).toEqual(['open']);
  });

  it('includes it for a caller who may see dm_only notes', () => {
    expect(Object.keys(listVisibleCampaignNames(G, { hideDmOnly: false })).sort()).toEqual(['open', 'secret']);
  });
});
