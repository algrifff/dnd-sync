import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID as groupId } from '@/lib/users';
import { getSessionStatus } from '@/lib/sessions';
import { validateSheet } from '@/lib/validateSheet';
import type { PmNode } from '@/lib/md-to-pm';
import type { PmDoc } from '@/lib/note-edits';
import { listRelations } from '@/lib/relations';
import {
  applyWrapUp,
  loadPendingWrapUp,
  loadVisibleSession,
  submitWrapUp,
  WrapUpSubmission,
  wrapUpContext,
  type Relation,
  type SubmittedMention,
  type SubmittedRelation,
  type WrapUpProposal,
} from './wrap-up';

const SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-11-the-mill.md';
const SECRET_SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-12-the-vault.md';
const BRAM = 'Campaigns/Ashfall/People/bram.md';
const SECRET = 'Campaigns/Ashfall/People/the-spy.md';
const PRIVATE = 'World Lore/owner-notes.md';
const MILL = 'Campaigns/Ashfall/Places/the-mill.md';
const MENTIONED_ONLY = 'Campaigns/Ashfall/Places/the-pond.md';
const KARA = 'Campaigns/Ashfall/Characters/kara.md';
const LANTERN = 'Campaigns/Ashfall/Loot/lantern.md';

let userId: string;

function text(t: string): PmNode {
  return { type: 'text', text: t };
}
function paragraph(...content: PmNode[]): PmNode {
  return { type: 'paragraph', content };
}
function plain(node: PmNode): string {
  if (node.type === 'wikilink') return String(node.attrs?.label ?? '');
  return node.type === 'text' ? (node.text ?? '') : (node.content ?? []).map(plain).join('');
}
function wikilink(target: string, label: string): PmNode {
  return { type: 'wikilink', attrs: { target, label, anchor: null, orphan: false } };
}

function seed(opts: {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body?: PmDoc;
  dmOnly?: boolean;
  gmOnly?: boolean;
}): void {
  const body = opts.body ?? { type: 'doc', content: [paragraph(text(`About ${opts.title}.`))] };
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), body, 'default');
  ydoc.getText('title').insert(0, opts.title);
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(), groupId, opts.path, opts.title, JSON.stringify(body),
      (body.content ?? []).map(plain).join('\n'), Y.encodeStateAsUpdate(ydoc),
      JSON.stringify(opts.frontmatter), now, userId, now, userId,
      opts.dmOnly ? 1 : 0, opts.gmOnly ? 1 : 0,
    );
}

function row(path: string): { content_json: string; frontmatter_json: string; dm_only: number; gm_only: number } {
  const found = getDb()
    .query<
      { content_json: string; frontmatter_json: string; dm_only: number; gm_only: number },
      [string, string]
    >('SELECT content_json, frontmatter_json, dm_only, gm_only FROM notes WHERE group_id = ? AND path = ?')
    .get(groupId, path);
  if (!found) throw new Error(`missing ${path}`);
  return found;
}

function contentOf(path: string): PmDoc {
  return JSON.parse(row(path).content_json) as PmDoc;
}

function titleOf(path: string): string {
  return getDb()
    .query<{ title: string }, [string, string]>('SELECT title FROM notes WHERE group_id = ? AND path = ?')
    .get(groupId, path)!.title;
}

function noteExists(path: string): boolean {
  return (
    getDb()
      .query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?')
      .get(groupId, path)!.n > 0
  );
}

function allNotes(): Array<{ path: string; content_json: string }> {
  return getDb()
    .query<{ path: string; content_json: string }, [string]>(
      'SELECT path, content_json FROM notes WHERE group_id = ? ORDER BY path',
    )
    .all(groupId);
}

function wikilinkTargets(node: PmNode | PmDoc): string[] {
  const out: string[] = [];
  const walk = (n: PmNode | PmDoc): void => {
    if (n.type === 'wikilink') out.push(String((n as PmNode).attrs?.target));
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return out;
}

function historyEntries(doc: PmDoc): string[] {
  const nodes = doc.content ?? [];
  const i = nodes.findIndex((n) => n.type === 'heading' && plain(n) === 'History');
  if (i === -1) return [];
  return (nodes[i + 1]?.content ?? []).map(plain);
}

function existing(name: string, path: string, kind: SubmittedMention['kind'], historyEntry: string, certain = true): SubmittedMention {
  return { name, kind, match: { type: 'existing', path, certain }, historyEntry };
}
function fresh(name: string, kind: SubmittedMention['kind'], summary: string, historyEntry: string, title = name): SubmittedMention {
  return { name, kind, match: { type: 'new', title, summary }, historyEntry };
}

function proposalFrom(sessionPath: string, mentions: SubmittedMention[]): WrapUpProposal {
  return { sessionPath, generatedAt: 1, mentions: mentions.map((m, i) => ({ ...m, id: `m${i + 1}` })), relations: [], suggestions: [] };
}

function sessionNote(path: string) {
  const found = loadVisibleSession(groupId, 'admin', path);
  if (found.status !== 'ok') throw new Error(`no session ${path}`);
  return found.note;
}

function contextFor(role: 'admin' | 'editor' | 'viewer', limit = 200, cursor = 0) {
  return wrapUpContext({ groupId, role, session: sessionNote(SESSION), limit, cursor });
}

beforeAll(async () => {
  setupTestDb();
  userId = (await createUser({ username: 'closer', displayName: 'Closer', password: 'correct-horse-battery', role: 'viewer' })).id;
  getDb()
    .query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, 'ashfall', 'Ashfall', 'Campaigns/Ashfall', Date.now());

  seed({
    path: SESSION,
    title: 'The Mill',
    frontmatter: { kind: 'session', campaigns: ['ashfall'] },
    body: { type: 'doc', content: [paragraph(text('We met Bram at the Mill. A wight rose from the millpond. Bram gave us the Rusted Key.'))] },
  });
  seed({
    path: SECRET_SESSION,
    title: 'The Vault',
    frontmatter: { kind: 'session', campaigns: ['ashfall'] },
    body: { type: 'doc', content: [paragraph(text('Zed unlocked the vault.'))] },
    dmOnly: true,
  });
  seed({ path: BRAM, title: 'Bram', frontmatter: { kind: 'person' } });
  seed({ path: SECRET, title: 'The Spy', frontmatter: { kind: 'npc' }, dmOnly: true });
  seed({ path: PRIVATE, title: 'Owner Notes', frontmatter: {}, gmOnly: true });
  seed({
    path: MILL,
    title: 'The Mill',
    frontmatter: { kind: 'location' },
    body: {
      type: 'doc',
      content: [
        paragraph(text('A mill.')),
        { type: 'heading', attrs: { level: 2 }, content: [text('History')] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(wikilink(SESSION, 'The Mill'), text(': Where the party met Bram.'))] }] },
      ],
    },
  });
  seed({
    path: MENTIONED_ONLY,
    title: 'The Pond',
    frontmatter: { kind: 'location' },
    body: { type: 'doc', content: [paragraph(text('See '), wikilink(SESSION, 'The Mill'), text('.'))] },
  });
  seed({ path: KARA, title: 'Kara', frontmatter: { kind: 'character' } });
  for (const from of [MILL, MENTIONED_ONLY]) {
    getDb()
      .query('INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)')
      .run(groupId, from, SESSION);
  }
});
afterAll(() => teardownTestDb());

describe('wrapUpContext', () => {
  it('lists only the Notes a Player can see, as their canonical kind, without Characters or Sessions', () => {
    const ctx = contextFor('viewer');

    expect(ctx.candidates.map((c) => [c.path, c.kind])).toEqual([
      [BRAM, 'person'],
      [MILL, 'location'],
      [MENTIONED_ONLY, 'location'],
    ]);
    expect(ctx.session).toEqual({ path: SESSION, title: 'The Mill', status: 'open' });
    expect(ctx.log).toContain('We met Bram at the Mill.');
  });

  it('shows a Co-GM Secret Notes and the Owner Private ones too', () => {
    expect(contextFor('editor').candidates.map((c) => c.path)).toContain(SECRET);
    expect(contextFor('editor').candidates.map((c) => c.path)).not.toContain(PRIVATE);

    const owner = contextFor('admin').candidates;

    expect(owner.map((c) => c.path)).toEqual(expect.arrayContaining([SECRET, PRIVATE]));
    expect(owner.find((c) => c.path === PRIVATE)?.kind).toBe('lore');
    expect(owner.find((c) => c.path === SECRET)?.kind).toBe('person');
  });

  it('flags a Note as recorded only when its History links this Session, not when it merely links it', () => {
    const recorded = Object.fromEntries(contextFor('viewer').candidates.map((c) => [c.path, c.recorded]));

    expect(recorded).toEqual({ [BRAM]: false, [MILL]: true, [MENTIONED_ONLY]: false });
  });

  it('pages through the candidates', () => {
    const first = contextFor('viewer', 2, 0);
    const second = contextFor('viewer', 2, first.nextCursor!);

    expect(first.candidates.map((c) => c.path)).toEqual([BRAM, MILL]);
    expect(first.nextCursor).toBe(2);
    expect(second.candidates.map((c) => c.path)).toEqual([MENTIONED_ONLY]);
    expect(second.nextCursor).toBeNull();
  });
});

describe('WrapUpSubmission', () => {
  const valid = {
    sessionPath: SESSION,
    mentions: [{ name: 'Bram', kind: 'person', match: { type: 'existing', path: BRAM, certain: true }, historyEntry: 'Gave the key.' }],
  };

  it('accepts a well-formed proposal and collapses stray whitespace', () => {
    const parsed = WrapUpSubmission.parse({
      ...valid,
      mentions: [{ ...valid.mentions[0], name: '  the\n innkeeper ', historyEntry: 'Gave\n\nthe   key. ' }],
    });

    expect(parsed.mentions[0]).toMatchObject({ name: 'the innkeeper', historyEntry: 'Gave the key.' });
  });

  it('strips control, zero-width and bidi characters from prose', () => {
    const parsed = WrapUpSubmission.parse({
      ...valid,
      mentions: [{ ...valid.mentions[0], name: 'Br\u200Bam\u0007', historyEntry: '\u202EGave\u0000 the\ufeff key\u0085.\u2066' }],
    });

    expect(parsed.mentions[0]).toMatchObject({ name: 'Bram', historyEntry: 'Gave the key.' });
  });

  it('refuses prose that is nothing but invisible characters', () => {
    const payload = { ...valid, mentions: [{ ...valid.mentions[0], historyEntry: '\u200B\u0000 \ufeff' }] };

    expect(WrapUpSubmission.safeParse(payload).success).toBe(false);
  });

  it('accepts a title in a non-Latin script', () => {
    const payload = { ...valid, mentions: [{ ...valid.mentions[0], match: { type: 'new', title: '\u0411\u0440\u043E\u043C', summary: '' } }] };

    expect(WrapUpSubmission.safeParse(payload).success).toBe(true);
  });

  it.each([
    ['an unknown key', { ...valid, extra: 1 }],
    ['an empty History entry', { ...valid, mentions: [{ ...valid.mentions[0], historyEntry: '   ' }] }],
    ['an unknown kind', { ...valid, mentions: [{ ...valid.mentions[0], kind: 'character' }] }],
    ['an existing match with no certainty', { ...valid, mentions: [{ ...valid.mentions[0], match: { type: 'existing', path: BRAM } }] }],
    ['a new match with no title', { ...valid, mentions: [{ ...valid.mentions[0], match: { type: 'new', summary: '' } }] }],
    ['a mention whose name has no letters or digits', { ...valid, mentions: [{ ...valid.mentions[0], name: '???' }] }],
    ['a new match whose title has no letters or digits', { ...valid, mentions: [{ ...valid.mentions[0], match: { type: 'new', title: '???', summary: '' } }] }],
    ['a match carrying both shapes', { ...valid, mentions: [{ ...valid.mentions[0], match: { type: 'existing', path: BRAM, certain: true, title: 'x' } }] }],
    ['more than 60 mentions', { ...valid, mentions: Array.from({ length: 61 }, () => valid.mentions[0]) }],
  ])('rejects %s', (_label, payload) => {
    expect(WrapUpSubmission.safeParse(payload).success).toBe(false);
  });
});

describe('submitWrapUp', () => {
  it('stores the proposal with stable ids and replaces an earlier one', () => {
    const first = submitWrapUp({
      groupId, role: 'viewer',
      submission: { sessionPath: SESSION, mentions: [existing('Bram', BRAM, 'person', 'Gave the key.'), fresh('wight', 'creature', '', 'Rose.')] },
    });
    expect(first.status).toBe('ok');
    const ids = loadPendingWrapUp(groupId, 'viewer', SESSION)!.mentions.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);

    submitWrapUp({
      groupId, role: 'viewer',
      submission: { sessionPath: SESSION, mentions: [fresh('Rusted Key', 'item', 'Iron.', 'Given.')] },
    });

    expect(loadPendingWrapUp(groupId, 'viewer', SESSION)!.mentions.map((m) => m.name)).toEqual(['Rusted Key']);
  });

  it('lets a Player submit a mention of a Note they can see and refuses one they cannot, as if it did not exist', () => {
    const hidden = submitWrapUp({
      groupId, role: 'viewer',
      submission: { sessionPath: SESSION, mentions: [existing('the spy', SECRET, 'person', 'Seen.')] },
    });
    const missing = submitWrapUp({
      groupId, role: 'viewer',
      submission: { sessionPath: SESSION, mentions: [existing('ghost', 'Campaigns/Ashfall/People/ghost.md', 'person', 'Seen.')] },
    });
    const owner = submitWrapUp({
      groupId, role: 'admin',
      submission: { sessionPath: SESSION, mentions: [existing('the spy', SECRET, 'person', 'Seen.')] },
    });

    expect(hidden).toEqual({ status: 'not_found' });
    expect(missing).toEqual({ status: 'not_found' });
    expect(owner.status).toBe('ok');
  });

  it('refuses a mention that targets a Character, which only gets Suggestions', () => {
    const result = submitWrapUp({
      groupId, role: 'admin',
      submission: { sessionPath: SESSION, mentions: [existing('Kara', KARA, 'person', 'Fought.')] },
    });

    expect(result).toEqual({ status: 'invalid_target', mention: 'Kara' });
  });

  it('stores nothing when any mention is refused', () => {
    submitWrapUp({ groupId, role: 'viewer', submission: { sessionPath: SESSION, mentions: [fresh('Marker', 'lore', '', 'Kept.')] } });

    submitWrapUp({
      groupId, role: 'viewer',
      submission: { sessionPath: SESSION, mentions: [fresh('Fine', 'lore', '', 'Ok.'), existing('the spy', SECRET, 'person', 'Seen.')] },
    });

    expect(loadPendingWrapUp(groupId, 'viewer', SESSION)!.mentions.map((m) => m.name)).toEqual(['Marker']);
  });

  it('reads a Secret Session as missing for a Player and open to a Co-GM', () => {
    const submission = { sessionPath: SECRET_SESSION, mentions: [] };

    expect(submitWrapUp({ groupId, role: 'viewer', submission })).toEqual({ status: 'not_found' });
    expect(submitWrapUp({ groupId, role: 'editor', submission }).status).toBe('ok');
  });

  it('reports a Note that is not a Session', () => {
    expect(submitWrapUp({ groupId, role: 'admin', submission: { sessionPath: BRAM, mentions: [] } })).toEqual({
      status: 'not_a_session',
    });
  });
});

describe('loadPendingWrapUp', () => {
  it('drops mentions of Notes the reader cannot see', () => {
    submitWrapUp({
      groupId, role: 'admin',
      submission: { sessionPath: SESSION, mentions: [existing('the spy', SECRET, 'person', 'Was seen.'), existing('Bram', BRAM, 'person', 'Was there.')] },
    });

    expect(loadPendingWrapUp(groupId, 'viewer', SESSION)!.mentions.map((m) => m.name)).toEqual(['Bram']);
    expect(loadPendingWrapUp(groupId, 'admin', SESSION)!.mentions.map((m) => m.name)).toEqual(['the spy', 'Bram']);
  });

  it('leaves no gap in the ids a Player sees where a hidden mention was, and applies by those ids', async () => {
    submitWrapUp({
      groupId, role: 'admin',
      submission: {
        sessionPath: SESSION,
        mentions: [
          existing('Bram', BRAM, 'person', 'Was there.'),
          existing('the spy', SECRET, 'person', 'Was seen.'),
          fresh('Lantern', 'item', 'A lamp.', 'Was lit.'),
        ],
      },
    });

    const player = loadPendingWrapUp(groupId, 'viewer', SESSION)!;
    const owner = loadPendingWrapUp(groupId, 'admin', SESSION)!;

    expect(player.mentions.map((m) => m.name)).toEqual(['Bram', 'Lantern']);
    expect(player.mentions.map((m) => m.id)).toEqual([owner.mentions[0]!.id, owner.mentions[2]!.id]);
    expect(player.mentions.every((m) => !/^m\d+$/.test(m.id))).toBe(true);

    const result = await applyWrapUp({
      groupId, userId, role: 'viewer', sessionPath: SESSION, proposal: player,
      decisions: { accepted: [player.mentions[1]!.id], asNew: [] },
    });

    expect(result.applied.map((a) => a.path)).toEqual([LANTERN]);
    expect(historyEntries(contentOf(SECRET))).toEqual([]);
  });
});

describe('applyWrapUp', () => {
  const proposal = proposalFrom(SESSION, [
    existing('Bram', BRAM, 'person', 'Gave the party the Rusted Key.'),
    existing('wight', BRAM, 'creature', 'Rose from the millpond.', false),
    fresh('Rusted Key', 'item', 'An old iron key from Bram.', 'Given to the party by Bram.'),
    existing('the Mill', MILL, 'location', 'Where the party met Bram.'),
  ]);
  const wight = 'Campaigns/Ashfall/Creatures/wight.md';
  const key = 'Campaigns/Ashfall/Loot/rusted-key.md';

  it('appends History, creates new Notes in their kind folder, links the log, closes the Session and clears the proposal', async () => {
    submitWrapUp({ groupId, role: 'viewer', submission: { sessionPath: SESSION, mentions: [fresh('Marker', 'lore', '', 'Kept.')] } });

    const result = await applyWrapUp({
      groupId, userId, role: 'viewer', sessionPath: SESSION, proposal,
      decisions: { accepted: ['m1', 'm2', 'm3'], asNew: ['m2'] },
    });

    expect(result.applied).toEqual([
      { id: 'm1', path: BRAM, created: false },
      { id: 'm2', path: wight, created: true },
      { id: 'm3', path: key, created: true },
    ]);
    expect(historyEntries(contentOf(BRAM))).toEqual(['The Mill: Gave the party the Rusted Key.']);
    expect(historyEntries(contentOf(wight))).toEqual(['The Mill: Rose from the millpond.']);
    expect(historyEntries(contentOf(key))).toEqual(['The Mill: Given to the party by Bram.']);
    expect(plain(contentOf(key).content![0]!)).toBe('An old iron key from Bram.');
    expect(titleOf(key)).toBe('Rusted Key');
    expect(titleOf(wight)).toBe('wight');
    expect(JSON.parse(row(wight).frontmatter_json).kind).toBe('creature');
    expect(wikilinkTargets(contentOf(SESSION))).toEqual([BRAM, wight, key]);
    expect(historyEntries(contentOf(MILL))).toEqual(['The Mill: Where the party met Bram.']);
    expect(getSessionStatus(groupId, SESSION)).toBe('closed');
    expect(loadPendingWrapUp(groupId, 'viewer', SESSION)).toBeNull();
  });

  it('seeds a new Note with a Sheet that validates for its kind', () => {
    const fm = JSON.parse(row(key).frontmatter_json) as { kind: string; sheet: unknown };

    expect(fm.kind).toBe('item');
    expect(validateSheet(fm.kind, fm.sheet).ok).toBe(true);
  });

  it('changes nothing when the same proposal is applied again', async () => {
    const before = allNotes();

    const result = await applyWrapUp({
      groupId, userId, role: 'viewer', sessionPath: SESSION, proposal,
      decisions: { accepted: ['m1', 'm2', 'm3'], asNew: ['m2'] },
    });

    expect(result.applied.map((a) => a.created)).toEqual([false, false, false]);
    expect(allNotes()).toEqual(before);
  });

  it('on a re-run, marks what is recorded so a client proposes only new things', async () => {
    const recorded = contextFor('viewer').candidates.filter((c) => c.recorded).map((c) => c.path);
    expect(recorded.sort()).toEqual([BRAM, MILL, key, wight, LANTERN].sort());

    const secondRun = proposalFrom(SESSION, [
      existing('Bram', BRAM, 'person', 'Gave the party the Rusted Key.'),
      existing('the pond', MENTIONED_ONLY, 'location', 'Where the wight rose.'),
    ]);
    const result = await applyWrapUp({
      groupId, userId, role: 'viewer', sessionPath: SESSION, proposal: secondRun,
      decisions: { accepted: ['m1', 'm2'], asNew: [] },
    });

    expect(result.applied.map((a) => a.path)).toEqual([BRAM, MENTIONED_ONLY]);
    expect(historyEntries(contentOf(BRAM))).toEqual(['The Mill: Gave the party the Rusted Key.']);
    expect(historyEntries(contentOf(MENTIONED_ONLY))).toEqual(['The Mill: Where the wight rose.']);
  });

  it('lands a new mention on a same-titled Note of that kind instead of creating one', async () => {
    const result = await applyWrapUp({
      groupId, userId, role: 'viewer', sessionPath: SESSION,
      proposal: proposalFrom(SESSION, [fresh('the mill', 'location', 'A mill.', 'Visited.', 'The Mill')]),
      decisions: { accepted: ['m1'], asNew: [] },
    });

    expect(result.applied).toEqual([{ id: 'm1', path: MILL, created: false }]);
    expect(historyEntries(contentOf(MILL))).toEqual(['The Mill: Where the party met Bram.']);
  });

  it('skips a mention of a Note the closer cannot see, and one it does not know', async () => {
    const result = await applyWrapUp({
      groupId, userId, role: 'viewer', sessionPath: SESSION,
      proposal: proposalFrom(SESSION, [existing('the spy', SECRET, 'person', 'Seen.')]),
      decisions: { accepted: ['m1', 'nope'], asNew: [] },
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'm1', reason: 'not_visible' },
      { id: 'nope', reason: 'unknown_mention' },
    ]);
    expect(historyEntries(contentOf(SECRET))).toEqual([]);
  });

  it('applies only the ticked mentions', async () => {
    const untouched = 'Campaigns/Ashfall/Quests/find-the-lost-smith.md';

    await applyWrapUp({
      groupId, userId, role: 'viewer', sessionPath: SESSION,
      proposal: proposalFrom(SESSION, [fresh('Find the Lost Smith', 'quest', '', 'Taken on.')]),
      decisions: { accepted: [], asNew: [] },
    });

    expect(noteExists(untouched)).toBe(false);
  });

  it('keeps a Note born from a Secret Session as hidden as that Session', async () => {
    const zed = 'Campaigns/Ashfall/People/zed.md';

    await applyWrapUp({
      groupId, userId, role: 'editor', sessionPath: SECRET_SESSION,
      proposal: proposalFrom(SECRET_SESSION, [fresh('Zed', 'person', 'A thief.', 'Opened the vault.')]),
      decisions: { accepted: ['m1'], asNew: [] },
    });

    expect(row(zed).dm_only).toBe(1);
    expect(JSON.parse(row(zed).frontmatter_json).dm_only).toBe(true);
    expect(wikilinkTargets(contentOf(SECRET_SESSION))).toEqual([zed]);
  });
});

describe('applyWrapUp edge cases', () => {
  const apply = (role: 'admin' | 'editor' | 'viewer', mentions: SubmittedMention[], asNew: string[] = []) =>
    applyWrapUp({
      groupId, userId, role, sessionPath: SESSION, proposal: proposalFrom(SESSION, mentions),
      decisions: { accepted: mentions.map((_, i) => `m${i + 1}`), asNew },
    });

  it('does not tell a Player a Secret Note holds a new mention path: it is created beside it and the result looks like any other creation', async () => {
    const before = allNotes().find((n) => n.path === SECRET)!;

    const hiddenCollision = await apply('viewer', [fresh('The Spy', 'person', 'A rumour.', 'Heard of.')]);
    const absent = await apply('viewer', [fresh('The Baker', 'person', 'Makes bread.', 'Sold bread.')]);

    expect(hiddenCollision.skipped).toEqual([]);
    expect(absent.skipped).toEqual([]);
    expect(Object.keys(hiddenCollision.applied[0]!)).toEqual(Object.keys(absent.applied[0]!));
    expect(hiddenCollision.applied[0]).toEqual({ id: 'm1', path: 'Campaigns/Ashfall/People/the-spy-2.md', created: true });
    expect(titleOf('Campaigns/Ashfall/People/the-spy-2.md')).toBe('The Spy');
    expect(allNotes().find((n) => n.path === SECRET)).toEqual(before);
    expect(row(SECRET).dm_only).toBe(1);
  });

  it('lands a repeated mention on the Note it created beside the Secret one', async () => {
    const again = await apply('viewer', [fresh('The Spy', 'person', 'A rumour.', 'Heard of.')]);

    expect(again.applied).toEqual([{ id: 'm1', path: 'Campaigns/Ashfall/People/the-spy-2.md', created: false }]);
    expect(historyEntries(contentOf(SECRET))).toEqual([]);
  });

  it('lets the Owner, who can see the Secret Note, land on it', async () => {
    const result = await apply('admin', [fresh('The Spy', 'person', 'A rumour.', 'Heard of.')]);

    expect(result.applied).toEqual([{ id: 'm1', path: SECRET, created: false }]);
  });

  it('skips an uncertain match switched to new when its name has no letters or digits to build a path from, without writing <Folder>/.md', async () => {
    const before = allNotes().length;

    const result = await apply('viewer', [existing('???', BRAM, 'person', 'Seen.', false)], ['m1']);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ id: 'm1', reason: 'invalid_title' }]);
    expect(allNotes()).toHaveLength(before);
    expect(allNotes().some((n) => n.path.endsWith('/.md'))).toBe(false);
  });

  it('creates a non-Latin Note under a hash-based path, titled as proposed, and finds it again next time', async () => {
    const mention = existing('\u0411\u0440\u043E\u043C', BRAM, 'person', 'Seen.', false);

    const first = await apply('viewer', [mention], ['m1']);
    const second = await apply('viewer', [mention], ['m1']);

    const path = first.applied[0]!.path;
    expect(path).toMatch(/^Campaigns\/Ashfall\/People\/note-[0-9a-f]{8}\.md$/);
    expect(first.applied[0]!.created).toBe(true);
    expect(titleOf(path)).toBe('\u0411\u0440\u043E\u043C');
    expect(second.applied).toEqual([{ id: 'm1', path, created: false }]);
  });

  it('reports a mention whose Note vanished before the edit as skipped, not applied or linked', async () => {
    const gone = 'Campaigns/Ashfall/People/vanishing-act.md';
    seed({ path: gone, title: 'Vanishing Act', frontmatter: { kind: 'person' } });
    const mentions = [existing('Vanishing Act', gone, 'person', 'Disappeared.'), existing('Bram', BRAM, 'person', 'Was there.')];

    const pending = apply('viewer', mentions);
    getDb().query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(groupId, gone);
    const result = await pending;

    expect(result.skipped).toEqual([{ id: 'm1', reason: 'edit_failed' }]);
    expect(result.applied.map((a) => a.id)).toEqual(['m2']);
    expect(wikilinkTargets(contentOf(SESSION))).not.toContain(gone);
  });
});

describe('Relationships in a Wrap-up', () => {
  const REL_SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-14-the-bridge.md';
  const GUILD = 'Campaigns/Ashfall/Lore/the-guild.md';
  // The flag lives in the frontmatter too, or the next save of the Note un-hides it.
  const INFORMANT = 'Campaigns/Ashfall/People/the-informant.md';
  const mention = (name: string): SubmittedRelation['from'] => ({ type: 'mention', name });
  const at = (path: string): SubmittedRelation['from'] => ({ type: 'existing', path });
  const relate = (from: SubmittedRelation['from'], relation: SubmittedRelation['relation'], to: SubmittedRelation['from'], note?: string): SubmittedRelation =>
    ({ from, relation, to, ...(note ? { note } : {}) });
  const submit = (role: 'admin' | 'viewer', mentions: SubmittedMention[], relations: SubmittedRelation[]) =>
    submitWrapUp({ groupId, role, submission: { sessionPath: REL_SESSION, mentions, relations } });
  const relationsOf = (path: string) => listRelations({ groupId, role: 'admin', path });

  beforeAll(() => {
    seed({
      path: REL_SESSION,
      title: 'The Bridge',
      frontmatter: { kind: 'session', campaigns: ['ashfall'] },
      body: { type: 'doc', content: [paragraph(text('Volo said he works for Bram. Kara swore to the guild.'))] },
    });
    seed({ path: GUILD, title: 'The Guild', frontmatter: { kind: 'lore' } });
    seed({ path: INFORMANT, title: 'The Informant', frontmatter: { kind: 'person', dm_only: true }, dmOnly: true });
  });

  describe('submitting', () => {
    it('stores each relation against the mention ids, matching names without regard to case', () => {
      const result = submit('viewer', [fresh('Volo', 'person', 'A chronicler.', 'Offered a job.')], [
        relate(mention('volo'), 'works_for', at(BRAM), 'Volo said so.'),
        relate(at(KARA), 'member_of', at(GUILD)),
      ]);

      expect(result.status).toBe('ok');
      const stored = loadPendingWrapUp(groupId, 'viewer', REL_SESSION)!;
      const volo = stored.mentions[0]!;
      expect(stored.relations.map(({ id: _id, ...rest }) => rest)).toEqual([
        { from: { type: 'mention', mentionId: volo.id }, relation: 'works_for', to: { type: 'existing', path: BRAM }, note: 'Volo said so.' },
        { from: { type: 'existing', path: KARA }, relation: 'member_of', to: { type: 'existing', path: GUILD } },
      ]);
      expect(new Set(stored.relations.map((r) => r.id)).size).toBe(2);
    });

    it.each([
      ['names no mention of the submission', [relate(mention('Nobody'), 'ally_of', at(BRAM))], 'unknown_mention'],
      ['names two mentions', [relate(mention('Volo'), 'ally_of', at(BRAM))], 'ambiguous_mention'],
      ['has the same Note at both ends', [relate(at(BRAM), 'ally_of', at(BRAM))], 'same_note'],
      ['has one mention at both ends', [relate(mention('Marta'), 'ally_of', mention('MARTA'))], 'same_note'],
      ['joins a mention to the existing Note it matched', [relate(mention('the miller'), 'ally_of', at(BRAM))], 'same_note'],
    ] as const)('refuses a relation that %s, naming its position', (_why, relations, problem) => {
      const mentions = [
        fresh('Volo', 'person', '', 'Seen.'),
        fresh('volo', 'creature', '', 'Seen too.'),
        fresh('Marta', 'person', '', 'Poured.'),
        existing('the miller', BRAM, 'person', 'Was there.'),
      ];

      expect(submit('viewer', mentions, [relate(at(KARA), 'ally_of', at(GUILD)), ...relations])).toEqual({
        status: 'invalid_relation', index: 1, problem,
      });
    });

    it('reads an existing end the submitter cannot see as not found, as for a hidden mention', () => {
      const relations = (path: string) => [relate(at(KARA), 'enemy_of', at(path))];

      expect(submit('viewer', [], relations(INFORMANT))).toEqual({ status: 'not_found' });
      expect(submit('viewer', [], relations('Campaigns/Ashfall/People/ghost.md'))).toEqual({ status: 'not_found' });
      expect(submit('admin', [], relations(INFORMANT)).status).toBe('ok');
    });

    it('leaves the earlier pending proposal alone when a relation is refused', () => {
      submit('viewer', [], [relate(at(KARA), 'ally_of', at(GUILD))]);
      const before = loadPendingWrapUp(groupId, 'admin', REL_SESSION);

      submit('viewer', [], [relate(mention('Nobody'), 'ally_of', at(GUILD))]);

      expect(loadPendingWrapUp(groupId, 'admin', REL_SESSION)).toEqual(before);
    });

    it('accepts only the shared types, at most 60, with strict ends', () => {
      const base = { sessionPath: REL_SESSION, mentions: [] };
      const good = { from: { type: 'existing', path: KARA }, relation: 'ally_of', to: { type: 'existing', path: GUILD } };

      expect(WrapUpSubmission.safeParse({ ...base, relations: [good] }).success).toBe(true);
      expect(WrapUpSubmission.parse(base).relations).toEqual([]);
      expect(WrapUpSubmission.safeParse({ ...base, relations: [{ ...good, relation: 'has_member' }] }).success).toBe(false);
      expect(WrapUpSubmission.safeParse({ ...base, relations: [{ ...good, relation: 'friends with' }] }).success).toBe(false);
      expect(WrapUpSubmission.safeParse({ ...base, relations: [{ ...good, to: { type: 'existing', path: GUILD, extra: 1 } }] }).success).toBe(false);
      expect(WrapUpSubmission.safeParse({ ...base, relations: Array.from({ length: 61 }, () => good) }).success).toBe(false);
      expect(WrapUpSubmission.safeParse({ ...base, relations: Array.from({ length: 60 }, () => good) }).success).toBe(true);
    });
  });

  describe('a stored proposal read back', () => {
    it('drops a relation that ends at a Note the reader cannot see, or at a mention that was dropped for them', () => {
      submit('admin', [existing('the informant', INFORMANT, 'person', 'Seen.'), existing('Bram', BRAM, 'person', 'Was there.')], [
        relate(at(KARA), 'enemy_of', at(INFORMANT)),
        relate(mention('the informant'), 'works_for', at(GUILD)),
        relate(mention('Bram'), 'member_of', at(GUILD)),
      ]);

      expect(loadPendingWrapUp(groupId, 'admin', REL_SESSION)!.relations).toHaveLength(3);
      const forPlayer = loadPendingWrapUp(groupId, 'viewer', REL_SESSION)!;
      expect(forPlayer.relations.map((r) => r.relation)).toEqual(['member_of']);
    });
  });

  describe('applying', () => {
    const rel = (id: string, from: Relation['from'], relation: Relation['relation'], to: Relation['from']): Relation => ({ id, from, relation, to });
    const m = (mentionId: string): Relation['from'] => ({ type: 'mention', mentionId });
    const p = (path: string): Relation['from'] => ({ type: 'existing', path });
    const volo = 'Campaigns/Ashfall/People/volo.md';

    const run = (
      proposal: WrapUpProposal,
      decisions: { accepted: string[]; acceptedRelations?: string[]; asNew?: string[] },
      role: 'admin' | 'viewer' = 'viewer',
    ) =>
      applyWrapUp({ groupId, userId, role, sessionPath: REL_SESSION, proposal, decisions: { asNew: [], ...decisions } });

    const proposal = (): WrapUpProposal => ({
      ...proposalFrom(REL_SESSION, [fresh('Volo', 'person', 'A chronicler.', 'Offered a job.'), existing('Bram', BRAM, 'person', 'Was there.')]),
      relations: [
        rel('r1', m('m1'), 'works_for', p(BRAM)),
        rel('r2', p(KARA), 'member_of', p(GUILD)),
        rel('r3', m('m2'), 'ally_of', m('m1')),
      ],
    });

    it('records a relation to a Note the Wrap-up creates, a relation between existing Notes, and links the pair', async () => {
      const result = await run(proposal(), { accepted: ['m1', 'm2'], acceptedRelations: ['r1', 'r2'] });

      expect(result.relationsAdded).toEqual([{ id: 'r1', status: 'added' }, { id: 'r2', status: 'added' }]);
      expect(result.relationsSkipped).toEqual([]);
      expect(relationsOf(volo).map((r) => [r.relation, r.path, r.sessionPath])).toEqual([['works_for', BRAM, REL_SESSION]]);
      expect(relationsOf(GUILD).map((r) => [r.relation, r.path])).toEqual([['has_member', KARA]]);
      const manual = getDb()
        .query<{ is_manual: number }, [string, string, string]>('SELECT is_manual FROM note_links WHERE group_id = ? AND from_path = ? AND to_path = ?')
        .get(groupId, volo, BRAM);
      expect(manual?.is_manual).toBe(1);
    });

    it('records a repeated apply as unchanged and writes no second row', async () => {
      const count = (): number => getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM note_relations').get()!.n;
      const before = count();

      const result = await run(proposal(), { accepted: ['m1', 'm2'], acceptedRelations: ['r1', 'r2'] });

      expect(result.relationsAdded).toEqual([{ id: 'r1', status: 'unchanged' }, { id: 'r2', status: 'unchanged' }]);
      expect(count()).toBe(before);
    });

    it('records only the relations that were ticked', async () => {
      const unticked = { ...proposal(), relations: [rel('r9', p(KARA), 'enemy_of', p(MILL))] };

      const result = await run(unticked, { accepted: [], acceptedRelations: [] });

      expect(result.relationsAdded).toEqual([]);
      expect(result.relationsSkipped).toEqual([]);
      expect(relationsOf(KARA).map((r) => r.relation)).not.toContain('enemy_of');
    });

    it('skips a relation whose mention was not ticked, and reports it rather than failing', async () => {
      const pond = { ...proposal(), relations: [rel('r4', m('m2'), 'located_in', p(MENTIONED_ONLY))] };

      const result = await run(pond, { accepted: ['m1'], acceptedRelations: ['r4'] });

      expect(result.relationsAdded).toEqual([]);
      expect(result.relationsSkipped).toEqual([{ id: 'r4', reason: 'mention_not_applied' }]);
      expect(relationsOf(MENTIONED_ONLY)).toEqual([]);
      expect(getSessionStatus(groupId, REL_SESSION)).toBe('closed');
    });

    it('skips a relation whose mention could not land', async () => {
      const gone = 'Campaigns/Ashfall/People/vanishing-act-2.md';
      seed({ path: gone, title: 'Vanishing Act 2', frontmatter: { kind: 'person' } });
      const vanishing = {
        ...proposalFrom(REL_SESSION, [existing('Vanishing Act 2', gone, 'person', 'Disappeared.')]),
        relations: [rel('r5', m('m1'), 'ally_of', p(BRAM))],
      };

      const pending = run(vanishing, { accepted: ['m1'], acceptedRelations: ['r5'] });
      getDb().query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(groupId, gone);
      const result = await pending;

      expect(result.relationsSkipped).toEqual([{ id: 'r5', reason: 'mention_not_applied' }]);
      expect(relationsOf(BRAM).map((r) => r.path)).not.toContain(gone);
    });

    it('skips a relation to an existing Note the closer cannot see, but not for the Owner', async () => {
      const hidden = { ...proposal(), relations: [rel('r6', p(KARA), 'enemy_of', p(INFORMANT))] };

      const asPlayer = await run(hidden, { accepted: [], acceptedRelations: ['r6'] });
      const asOwner = await run(hidden, { accepted: [], acceptedRelations: ['r6'] }, 'admin');

      expect(asPlayer.relationsSkipped).toEqual([{ id: 'r6', reason: 'not_visible' }]);
      expect(asOwner.relationsAdded).toEqual([{ id: 'r6', status: 'added' }]);
    });

    it('skips an id the proposal does not hold, and a relation whose two mentions landed on one Note', async () => {
      const bell = 'Campaigns/Ashfall/Loot/old-bell.md';
      const twins = {
        ...proposalFrom(REL_SESSION, [
          fresh('Old Bell', 'item', '', 'Rang.'),
          existing('old bell', 'Campaigns/Ashfall/Loot/the-other-bell.md', 'item', 'Rang again.', false),
        ]),
        relations: [rel('r7', m('m1'), 'related_to', m('m2'))],
      };

      const result = await run(twins, { accepted: ['m1', 'm2'], asNew: ['m2'], acceptedRelations: ['r7', 'r404'] });

      expect(result.applied.map((a) => a.path)).toEqual([bell, bell]);
      expect(result.relationsSkipped).toEqual([{ id: 'r7', reason: 'same_note' }, { id: 'r404', reason: 'unknown_relation' }]);
      expect(relationsOf(bell)).toEqual([]);
    });

    it('applies relations after the mentions, so one to a Note created in the same Wrap-up has a path', async () => {
      const lonely = { ...proposalFrom(REL_SESSION, [fresh('Marta', 'person', '', 'Poured ale.')]), relations: [rel('r8', p(GUILD), 'leads', m('m1'))] };

      const result = await run(lonely, { accepted: ['m1'], acceptedRelations: ['r8'] });

      expect(result.relationsAdded).toEqual([{ id: 'r8', status: 'added' }]);
      expect(relationsOf('Campaigns/Ashfall/People/marta.md').map((r) => [r.relation, r.path])).toEqual([['led_by', GUILD]]);
    });
  });
});
