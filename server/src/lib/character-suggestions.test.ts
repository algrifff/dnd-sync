import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID as groupId } from '@/lib/users';
import { buildSessionCookies, createSession } from '@/lib/session';
import { moveFolder } from '@/lib/move-folder';
import { visibilityFor } from '@/lib/notes';
import { createTools } from '@/lib/ai/tools';
import { POST as moveRoute } from '@/app/api/notes/move/route';
import * as noteEdits from '@/lib/note-edits';
import type { PmNode } from '@/lib/md-to-pm';
import type { PmDoc } from '@/lib/note-edits';
import {
  acceptSuggestion,
  dismissSuggestion,
  listMySuggestions,
} from './character-suggestions';
import { writePendingWrapUpJson } from './sessions';
import { loadPendingWrapUp, submitWrapUp, type Suggestion, type WrapUpProposal } from './wrap-up';
import { applyStaged } from './wrap-up.testing';

const SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-11-the-mill.md';
const SECRET_SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-12-the-vault.md';
const KARA = 'Campaigns/Ashfall/Characters/kara.md';
const SECRET_HERO = 'Campaigns/Ashfall/Characters/the-hidden-one.md';
const ORPHAN = 'Campaigns/Ashfall/Characters/no-player.md';
const BRAM = 'Campaigns/Ashfall/People/bram.md';

let ownerId: string;
let karaPlayer: string;
let otherPlayer: string;

const KARA_SHEET = {
  name: 'Kara',
  level: 3,
  hit_points: { current: 20, max: 24, temporary: 0 },
  hp_current: 20,
  hp_max: 24,
  ac: 15,
  str: 16,
  items: ['Rope'],
  inventory: [{ ref: { name: 'Rope' }, quantity: 1, equipped: false, attuned: false }],
};

function seed(path: string, title: string, frontmatter: Record<string, unknown>, opts: { dmOnly?: boolean } = {}): void {
  const body: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `About ${title}.` }] }] };
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), body, 'default');
  ydoc.getText('title').insert(0, title);
  const now = Date.now();
  const fm = JSON.stringify(frontmatter);
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 0, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      randomUUID(), groupId, path, title, JSON.stringify(body), `About ${title}.`,
      Y.encodeStateAsUpdate(ydoc), fm, now, ownerId, now, ownerId, opts.dmOnly ? 1 : 0,
    );
  deriveAllIndexes({ groupId, notePath: path, frontmatterJson: fm });
}

function noteRow(path: string): { content_json: string; frontmatter_json: string } {
  return getDb()
    .query<{ content_json: string; frontmatter_json: string }, [string, string]>(
      'SELECT content_json, frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path)!;
}

function sheetOf(path: string): Record<string, unknown> {
  return (JSON.parse(noteRow(path).frontmatter_json) as { sheet: Record<string, unknown> }).sheet;
}

function plain(node: PmNode): string {
  if (node.type === 'wikilink') return String(node.attrs?.label ?? '');
  return node.type === 'text' ? (node.text ?? '') : (node.content ?? []).map(plain).join('');
}

function historyEntries(path: string): string[] {
  const nodes = (JSON.parse(noteRow(path).content_json) as PmDoc).content ?? [];
  const i = nodes.findIndex((n) => n.type === 'heading' && plain(n) === 'History');
  return i === -1 ? [] : (nodes[i + 1]?.content ?? []).map(plain);
}

function suggestion(id: string, characterPath: string, over: Partial<Suggestion> = {}): Suggestion {
  return { id, characterPath, story: 'Carried Bram out of the burning mill.', items: [{ name: 'Rusted Key', quantity: 1 }], ...over };
}

function proposalOf(suggestions: Suggestion[]): WrapUpProposal {
  return { sessionPath: SESSION, generatedAt: 1, mentions: [], relations: [], suggestions };
}

async function wrapUp(suggestions: Suggestion[]): Promise<Awaited<ReturnType<typeof applyStaged>>> {
  return applyStaged({
    groupId, userId: ownerId, role: 'admin', sessionPath: SESSION,
    proposal: proposalOf(suggestions), decisions: { accepted: [], asNew: [] },
  });
}

const mineFor = (userId: string) => listMySuggestions({ userId });
const accept = (userId: string, id: string) => acceptSuggestion({ userId, id });
const dismiss = (userId: string, id: string) => dismissSuggestion({ userId, id });

beforeAll(async () => {
  setupTestDb();
  const mk = (username: string, role: 'admin' | 'viewer') =>
    createUser({ username, displayName: username, password: 'correct-horse-battery', role });
  ownerId = (await mk('owner', 'admin')).id;
  karaPlayer = (await mk('kara-player', 'viewer')).id;
  otherPlayer = (await mk('other-player', 'viewer')).id;
  getDb()
    .query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, 'ashfall', 'Ashfall', 'Campaigns/Ashfall', Date.now());
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM character_suggestions');
  db.exec('DELETE FROM notes');
  seed(SESSION, 'The Mill', { kind: 'session', campaigns: ['ashfall'] });
  seed(SECRET_SESSION, 'The Vault', { kind: 'session', campaigns: ['ashfall'] }, { dmOnly: true });
  seed(KARA, 'Kara', { kind: 'character', player: 'kara-player', sheet: KARA_SHEET });
  seed(SECRET_HERO, 'The Hidden One', { kind: 'character', player: 'kara-player', sheet: { name: 'The Hidden One' } }, { dmOnly: true });
  seed(ORPHAN, 'No Player', { kind: 'character', sheet: { name: 'No Player' } });
  seed(BRAM, 'Bram', { kind: 'person' });
});

describe('storing Suggestions when a Wrap-up is applied', () => {
  it('holds a Suggestion for the Player of the Character without changing the Character', async () => {
    const before = noteRow(KARA);

    const result = await wrapUp([suggestion('s1', KARA)]);

    expect(result.suggestions).toEqual({ stored: 1, skipped: [] });
    expect(mineFor(karaPlayer).map((s) => s.characterPath)).toEqual([KARA]);
    expect(noteRow(KARA)).toEqual(before);
  });

  it('skips a Character that has no Player', async () => {
    const result = await wrapUp([suggestion('s1', ORPHAN)]);

    expect(result.suggestions).toEqual({ stored: 0, skipped: [{ id: 's1', reason: 'no_player' }] });
  });

  it('holds nothing for a Character the closer cannot see: the proposal they apply never had it', async () => {
    const result = await applyStaged({
      groupId, userId: otherPlayer, role: 'viewer', sessionPath: SESSION,
      proposal: proposalOf([suggestion('s1', SECRET_HERO)]), decisions: { accepted: [], asNew: [] },
    });

    expect(result.suggestions).toEqual({ stored: 0, skipped: [] });
    expect(mineFor(karaPlayer)).toEqual([]);
  });

  it('adds nothing when the same Wrap-up is applied again', async () => {
    await wrapUp([suggestion('s1', KARA)]);

    const again = await wrapUp([suggestion('s1', KARA)]);

    expect(again.suggestions.stored).toBe(0);
    expect(mineFor(karaPlayer)).toHaveLength(1);
  });

  it('does not offer a dismissed Suggestion again on a re-run, but does add a new Character', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    dismiss(karaPlayer, mineFor(karaPlayer)[0]!.id);

    seed('Campaigns/Ashfall/Characters/tam.md', 'Tam', { kind: 'character', player: 'other-player', sheet: { name: 'Tam' } });
    const again = await wrapUp([suggestion('s1', KARA), suggestion('s2', 'Campaigns/Ashfall/Characters/tam.md')]);

    expect(again.suggestions.stored).toBe(1);
    expect(mineFor(karaPlayer)).toEqual([]);
    expect(mineFor(otherPlayer).map((s) => s.characterPath)).toEqual(['Campaigns/Ashfall/Characters/tam.md']);
  });
});

describe('submitting Suggestions', () => {
  const submit = (suggestions: Array<{ characterPath: string; story: string | null; items: Array<{ name: string; quantity: number }> }>, role: 'admin' | 'viewer' = 'viewer') =>
    submitWrapUp({ groupId, role, submission: { sessionPath: SESSION, mentions: [], suggestions } });

  it('stores Suggestions on the pending proposal with opaque ids', () => {
    const result = submit([{ characterPath: KARA, story: 'Saved Bram.', items: [] }]);

    expect(result.status).toBe('ok');
    expect(loadPendingWrapUp(groupId, 'viewer', SESSION)!.suggestions.map((s) => s.id)).toEqual([expect.stringMatching(/^s_[0-9a-f]{8}$/)]);
  });

  it('rejects a Suggestion for a Note that is not a Character', () => {
    expect(submit([{ characterPath: BRAM, story: 'Hi.', items: [] }])).toMatchObject({
      status: 'invalid_suggestion_target',
      characterPath: BRAM,
    });
  });

  it('reads a Character hidden from the submitter as not found', () => {
    expect(submit([{ characterPath: SECRET_HERO, story: 'Hi.', items: [] }]).status).toBe('not_found');
  });

  it('hides a Suggestion for a hidden Character from a Player resuming the proposal', () => {
    submit([{ characterPath: SECRET_HERO, story: 'Hi.', items: [] }], 'admin');

    expect(loadPendingWrapUp(groupId, 'viewer', SESSION)!.suggestions).toEqual([]);
    expect(loadPendingWrapUp(groupId, 'admin', SESSION)!.suggestions).toHaveLength(1);
  });

  it('refuses a Suggestion with neither a story nor an item', () => {
    expect(submit([{ characterPath: KARA, story: null, items: [] }])).toMatchObject({ status: 'invalid_body' });
  });

  it('reads a proposal stored before Suggestions existed as having none', () => {
    writePendingWrapUpJson(groupId, SESSION, JSON.stringify({ sessionPath: SESSION, generatedAt: 1, mentions: [] }));

    expect(loadPendingWrapUp(groupId, 'viewer', SESSION)!.suggestions).toEqual([]);
  });
});

describe('who can see a Suggestion', () => {
  it('lists it only for the Player it was addressed to', async () => {
    await wrapUp([suggestion('s1', KARA)]);

    expect(mineFor(otherPlayer)).toEqual([]);
    expect(mineFor(ownerId)).toEqual([]);
  });

  it('reads as not found to anyone else, for accept and dismiss', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const id = mineFor(karaPlayer)[0]!.id;

    expect(await accept(otherPlayer, id)).toEqual({ status: 'not_found' });
    expect(await accept(ownerId, id)).toEqual({ status: 'not_found' });
    expect(dismiss(otherPlayer, id)).toEqual({ status: 'not_found' });
    expect(mineFor(karaPlayer)).toHaveLength(1);
  });

  it('reads as not found once the Character belongs to another Player', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const id = mineFor(karaPlayer)[0]!.id;
    deriveAllIndexes({
      groupId, notePath: KARA,
      frontmatterJson: JSON.stringify({ kind: 'character', player: 'other-player', sheet: KARA_SHEET }),
    });

    expect(await accept(karaPlayer, id)).toEqual({ status: 'not_found' });
  });

  it('hides a Suggestion whose Session is hidden from the Player', async () => {
    await applyStaged({
      groupId, userId: ownerId, role: 'admin', sessionPath: SECRET_SESSION,
      proposal: { ...proposalOf([suggestion('s1', KARA)]), sessionPath: SECRET_SESSION },
      decisions: { accepted: [], asNew: [] },
    });

    expect(mineFor(karaPlayer)).toEqual([]);
  });
});

describe('accepting a Suggestion', () => {
  it('adds a History entry linking the Session and the item to the inventory', async () => {
    await wrapUp([suggestion('s1', KARA, { items: [{ name: 'Rusted Key', quantity: 2 }] })]);

    const result = await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);

    expect(result).toEqual({ status: 'ok', changed: true });
    expect(historyEntries(KARA)).toEqual(['The Mill: Carried Bram out of the burning mill.']);
    const sheet = sheetOf(KARA);
    expect(sheet.items).toEqual(['Rope', 'Rusted Key ×2']);
    expect(sheet.inventory).toEqual([
      { ref: { name: 'Rope' }, quantity: 1, equipped: false, attuned: false },
      { ref: { name: 'Rusted Key' }, quantity: 2, equipped: false, attuned: false },
    ]);
  });

  it('never touches stats', async () => {
    await wrapUp([suggestion('s1', KARA)]);

    await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);

    const { items: _i, inventory: _inv, ...stats } = sheetOf(KARA);
    const { items: _bi, inventory: _binv, ...statsBefore } = KARA_SHEET;
    expect(stats).toEqual(statsBefore);
  });

  it('raises the quantity of an item the Character already carries', async () => {
    await wrapUp([suggestion('s1', KARA, { story: null, items: [{ name: 'rope', quantity: 2 }] })]);

    await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);

    const sheet = sheetOf(KARA);
    expect((sheet.inventory as Array<{ quantity: number }>).map((e) => e.quantity)).toEqual([3]);
    expect(sheet.items).toEqual(['Rope ×3']);
  });

  it('raises a quantity already written in the flat list, keeping its spelling', async () => {
    getDb()
      .query('UPDATE notes SET frontmatter_json = ? WHERE group_id = ? AND path = ?')
      .run(JSON.stringify({ kind: 'character', player: 'kara-player', sheet: { ...KARA_SHEET, items: ['Rope ×2', 'Lantern'] } }), groupId, KARA);
    await wrapUp([suggestion('s1', KARA, { story: null, items: [{ name: 'ROPE', quantity: 2 }, { name: 'Lantern', quantity: 1 }] })]);

    await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);

    expect(sheetOf(KARA).items).toEqual(['Rope ×4', 'Lantern ×2']);
  });

  it('adds only items when there is no story, and only a story when there are no items', async () => {
    await wrapUp([suggestion('s1', KARA, { story: null })]);
    await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);
    expect(historyEntries(KARA)).toEqual([]);
    expect(sheetOf(KARA).items).toEqual(['Rope', 'Rusted Key']);

    const before = noteRow(KARA).frontmatter_json;
    seed('Campaigns/Ashfall/Characters/tam.md', 'Tam', { kind: 'character', player: 'other-player', sheet: { name: 'Tam' } });
    await wrapUp([suggestion('s2', 'Campaigns/Ashfall/Characters/tam.md', { items: [] })]);
    await accept(otherPlayer, mineFor(otherPlayer)[0]!.id);
    expect(historyEntries('Campaigns/Ashfall/Characters/tam.md')).toHaveLength(1);
    expect(noteRow(KARA).frontmatter_json).toBe(before);
  });

  it('adds nothing the second time', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const id = mineFor(karaPlayer)[0]!.id;
    await accept(karaPlayer, id);
    const after = noteRow(KARA);

    const again = await accept(karaPlayer, id);

    expect(again).toEqual({ status: 'ok', changed: false });
    expect(noteRow(KARA)).toEqual(after);
  });

  it('is no longer listed once accepted', async () => {
    await wrapUp([suggestion('s1', KARA)]);

    await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);

    expect(mineFor(karaPlayer)).toEqual([]);
  });

  it('refuses a Suggestion that was dismissed', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const id = mineFor(karaPlayer)[0]!.id;
    dismiss(karaPlayer, id);

    expect(await accept(karaPlayer, id)).toEqual({ status: 'conflict', resolved: 'dismissed' });
    expect(historyEntries(KARA)).toEqual([]);
  });

  it('leaves the Suggestion pending when the Sheet would not validate', async () => {
    await wrapUp([suggestion('s1', KARA, { story: null })]);
    getDb()
      .query('UPDATE notes SET frontmatter_json = ? WHERE group_id = ? AND path = ?')
      .run(JSON.stringify({ kind: 'character', player: 'kara-player', sheet: { ...KARA_SHEET, xp: 'banana' } }), groupId, KARA);

    const result = await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);

    expect(result).toEqual({ status: 'invalid_sheet' });
    expect(mineFor(karaPlayer)).toHaveLength(1);
  });

  it('writes nothing, not even the History entry, when the Sheet would not validate', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    getDb()
      .query('UPDATE notes SET frontmatter_json = ? WHERE group_id = ? AND path = ?')
      .run(JSON.stringify({ kind: 'character', player: 'kara-player', sheet: { ...KARA_SHEET, xp: 'banana' } }), groupId, KARA);
    const before = noteRow(KARA);

    const result = await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);

    expect(result).toEqual({ status: 'invalid_sheet' });
    expect(noteRow(KARA)).toEqual(before);
    expect(historyEntries(KARA)).toEqual([]);
    expect(dismiss(karaPlayer, mineFor(karaPlayer)[0]!.id)).toEqual({ status: 'ok', changed: true });
    expect(historyEntries(KARA)).toEqual([]);
  });

  it('releases the claim and reports a refused History edit instead of success', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const edit = spyOn(noteEdits, 'applyNoteEdit').mockResolvedValue({ status: 'rejected', reason: 'locked' });
    const before = noteRow(KARA);

    const result = await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);
    edit.mockRestore();

    expect(result).toEqual({ status: 'edit_failed', reason: 'locked' });
    expect(noteRow(KARA)).toEqual(before);
    expect(mineFor(karaPlayer)).toHaveLength(1);
  });

  it('releases the claim and reads as not found when the Character Note vanished mid-accept', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const edit = spyOn(noteEdits, 'applyNoteEdit').mockResolvedValue({ status: 'not_found' });

    const result = await accept(karaPlayer, mineFor(karaPlayer)[0]!.id);
    edit.mockRestore();

    expect(result).toEqual({ status: 'not_found' });
    expect(mineFor(karaPlayer)).toHaveLength(1);
  });
});

describe('moving a Character or Session', () => {
  const NEW_KARA = 'Campaigns/Ashfall/Characters/kara-the-bold.md';
  const NEW_SESSION = 'Campaigns/Ashfall/Adventure Log/2026-10-11-the-old-mill.md';

  const moveAs = async (from: string, to: string): Promise<void> => {
    const owner = createSession({ userId: ownerId, groupId, userAgent: null, ip: null });
    const cookie = buildSessionCookies(owner).map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await moveRoute(
      new Request('http://localhost/api/notes/move', {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to }),
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
  };

  it('still lists the pending Suggestion after the Character Note is renamed', async () => {
    await wrapUp([suggestion('s1', KARA)]);

    await moveAs(KARA, NEW_KARA);

    expect(mineFor(karaPlayer).map((s) => s.characterPath)).toEqual([NEW_KARA]);
  });

  it('still lists the pending Suggestion after the Session Note is renamed', async () => {
    await wrapUp([suggestion('s1', KARA)]);

    await moveAs(SESSION, NEW_SESSION);

    expect(mineFor(karaPlayer).map((s) => s.sessionPath)).toEqual([NEW_SESSION]);
  });

  it('keeps the Suggestion when the folder holding the Character is renamed', async () => {
    await wrapUp([suggestion('s1', KARA)]);

    const moved = await moveFolder({
      groupId, userId: ownerId, from: 'Campaigns/Ashfall/Characters', to: 'Campaigns/Ashfall/Heroes', vis: visibilityFor('admin'),
    });

    expect(moved.ok).toBe(true);
    expect(mineFor(karaPlayer).map((s) => s.characterPath)).toEqual(['Campaigns/Ashfall/Heroes/kara.md']);
  });

  it('keeps the Suggestion when the AI renames the Character Note', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const tools = createTools({ groupId, userId: ownerId, role: 'dm', sessionRole: 'admin', gmNamespace: true });

    const result = await tools.entity_move.execute!({ from: KARA, to: NEW_KARA }, { toolCallId: 't1', messages: [] });

    expect((result as { ok: boolean }).ok).toBe(true);
    expect(mineFor(karaPlayer).map((s) => s.characterPath)).toEqual([NEW_KARA]);
  });
});

describe('dismissing a Suggestion', () => {
  it('changes nothing on the Character and removes it from the list', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const before = noteRow(KARA);

    const result = dismiss(karaPlayer, mineFor(karaPlayer)[0]!.id);

    expect(result).toEqual({ status: 'ok', changed: true });
    expect(noteRow(KARA)).toEqual(before);
    expect(mineFor(karaPlayer)).toEqual([]);
  });

  it('does nothing the second time', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const id = mineFor(karaPlayer)[0]!.id;
    dismiss(karaPlayer, id);

    expect(dismiss(karaPlayer, id)).toEqual({ status: 'ok', changed: false });
  });

  it('refuses a Suggestion that was accepted', async () => {
    await wrapUp([suggestion('s1', KARA)]);
    const id = mineFor(karaPlayer)[0]!.id;
    await accept(karaPlayer, id);

    expect(dismiss(karaPlayer, id)).toEqual({ status: 'conflict', resolved: 'accepted' });
  });
});
