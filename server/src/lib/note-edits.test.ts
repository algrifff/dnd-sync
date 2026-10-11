import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import type { PmNode } from '@/lib/md-to-pm';
import {
  addHistoryEntry,
  applyNoteEdit,
  hasHistoryEntry,
  linkMention,
  type EditResult,
  type PmDoc,
} from './note-edits';

const SESSION = { sessionPath: 'Campaigns/c1/Sessions/Session 12.md', sessionTitle: 'Session 12' };

function text(t: string, marks?: PmNode['marks']): PmNode {
  return marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
}

function paragraph(...content: PmNode[]): PmNode {
  return { type: 'paragraph', content };
}

function heading(level: number, t: string): PmNode {
  return { type: 'heading', attrs: { level }, content: [text(t)] };
}

function link(target: string, label: string): PmNode {
  return { type: 'wikilink', attrs: { target, label, anchor: null, orphan: false } };
}

function bullets(...items: PmNode[][]): PmNode {
  return { type: 'bulletList', content: items.map((c) => ({ type: 'listItem', content: [paragraph(...c)] })) };
}

function doc(...content: PmNode[]): PmDoc {
  return { type: 'doc', content };
}

function changedDoc(result: EditResult): PmNode[] {
  if (result.status !== 'changed') throw new Error(`expected changed, got ${result.status}`);
  return result.doc.content ?? [];
}

const historyItem = (entry: string): PmNode[] => [
  link(SESSION.sessionPath, SESSION.sessionTitle),
  text(`: ${entry}`),
];

describe('addHistoryEntry', () => {
  it('adds a History heading and entry to an empty doc', () => {
    const result = addHistoryEntry(doc(), { ...SESSION, text: 'Killed at the Mill.' });

    expect(changedDoc(result)).toEqual([
      heading(2, 'History'),
      bullets(historyItem('Killed at the Mill.')),
    ]);
  });

  it('appends the heading after existing content, leaving that content untouched', () => {
    const intro = paragraph(text('A miller.', [{ type: 'bold' }]));
    const before = doc(intro);
    const snapshot = JSON.stringify(before);

    const content = changedDoc(addHistoryEntry(before, { ...SESSION, text: 'Met the party.' }));

    expect(content).toEqual([intro, heading(2, 'History'), bullets(historyItem('Met the party.'))]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('extends the list under an existing History heading and keeps later sections in place', () => {
    const earlier = [link('Campaigns/c1/Sessions/Session 11.md', 'Session 11'), text(': Hired the party.')];
    const notes = paragraph(text('Owes money.'));
    const before = doc(heading(2, 'History'), bullets(earlier), heading(2, 'Notes'), notes);

    const content = changedDoc(addHistoryEntry(before, { ...SESSION, text: 'Fled town.' }));

    expect(content).toEqual([
      heading(2, 'History'),
      bullets(earlier, historyItem('Fled town.')),
      heading(2, 'Notes'),
      notes,
    ]);
    expect(content[3]).toBe(notes);
  });

  it('adds a list when the History section holds only prose', () => {
    const prose = paragraph(text('Written by hand.'));
    const before = doc(heading(3, 'history'), prose, heading(2, 'Other'));

    const content = changedDoc(addHistoryEntry(before, { ...SESSION, text: 'Returned.' }));

    expect(content).toEqual([
      heading(3, 'history'),
      prose,
      bullets(historyItem('Returned.')),
      heading(2, 'Other'),
    ]);
  });

  it('is unchanged when the History section already links the Session', () => {
    const once = doc(...changedDoc(addHistoryEntry(doc(), { ...SESSION, text: 'First.' })));

    const again = addHistoryEntry(once, { ...SESSION, text: 'Reworded.' });

    expect(again).toEqual({ status: 'unchanged' });
  });

  it('still adds an entry when the Session is linked only outside the History section', () => {
    const before = doc(paragraph(text('See '), link(SESSION.sessionPath, 'Session 12')), heading(2, 'History'));

    const content = changedDoc(addHistoryEntry(before, { ...SESSION, text: 'Arrived.' }));

    expect(content.at(-1)).toEqual(bullets(historyItem('Arrived.')));
  });
});

describe('hasHistoryEntry', () => {
  it('is true only when the History section links the Session', () => {
    const recorded = doc(paragraph(text('Intro.')), heading(2, 'History'), bullets([link(SESSION.sessionPath, 'Session 12'), text(': Fought.')]));
    const linkedElsewhere = doc(paragraph(link(SESSION.sessionPath, 'Session 12')), heading(2, 'History'), bullets([text('Nothing yet.')]));
    const noHistory = doc(paragraph(text('Intro.')));

    expect(hasHistoryEntry(recorded, SESSION.sessionPath)).toBe(true);
    expect(hasHistoryEntry(linkedElsewhere, SESSION.sessionPath)).toBe(false);
    expect(hasHistoryEntry(noHistory, SESSION.sessionPath)).toBe(false);
  });
});

describe('linkMention', () => {
  const TARGET = 'Campaigns/c1/People/Bram.md';

  it('links the first whole-word occurrence, case-insensitively, keeping the words as written', () => {
    const second = paragraph(text('Bram again.'));
    const before = doc(paragraph(text('We met the innkeeper Bram at dusk.')), second);

    const content = changedDoc(linkMention(before, { text: 'bram', targetPath: TARGET }));

    expect(content).toEqual([
      paragraph(text('We met the innkeeper '), link(TARGET, 'Bram'), text(' at dusk.')),
      second,
    ]);
    expect(content[1]).toBe(second);
  });

  it('uses an explicit label and keeps the text marks on both sides', () => {
    const bold = [{ type: 'bold' }];
    const before = doc(paragraph(text('the innkeeper smiled', bold)));

    const content = changedDoc(
      linkMention(before, { text: 'the innkeeper', targetPath: TARGET, label: 'Bram' }),
    );

    expect(content).toEqual([
      paragraph({ ...link(TARGET, 'Bram'), marks: bold }, text(' smiled', bold)),
    ]);
  });

  it('skips partial words, inline code, links and code blocks', () => {
    const before = doc(
      paragraph(text('Brambles grow. '), text('Bram', [{ type: 'code' }])),
      paragraph(text('Bram', [{ type: 'link', attrs: { href: 'https://x' } }])),
      { type: 'codeBlock', attrs: { language: null }, content: [text('Bram')] },
      bullets([text('Ask Bram.')]),
    );

    const content = changedDoc(linkMention(before, { text: 'Bram', targetPath: TARGET }));

    expect(content.slice(0, 3)).toEqual((before.content ?? []).slice(0, 3));
    expect(content[3]).toEqual(bullets([text('Ask '), link(TARGET, 'Bram'), text('.')]));
  });

  it('is unchanged when the text never appears', () => {
    const result = linkMention(doc(paragraph(text('Nobody here.'))), { text: 'Bram', targetPath: TARGET });

    expect(result).toEqual({ status: 'unchanged' });
  });

  it('is unchanged when the doc already links the target', () => {
    const before = doc(paragraph(link(TARGET, 'the innkeeper'), text(' and Bram.')));

    const result = linkMention(before, { text: 'Bram', targetPath: TARGET });

    expect(result).toEqual({ status: 'unchanged' });
  });

  it('does not match text inside an existing wikilink to another note', () => {
    const before = doc(paragraph(link('Campaigns/c1/People/Bram Senior.md', 'Bram Senior')));

    const result = linkMention(before, { text: 'Bram', targetPath: TARGET });

    expect(result).toEqual({ status: 'unchanged' });
  });
});

describe('applyNoteEdit', () => {
  const groupId = 'g_note_edits';
  const userId = 'u_note_edits';
  const PATH = 'Campaigns/c1/People/Bram.md';

  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM note_links');
    db.exec('DELETE FROM notes');
    db.exec(`DELETE FROM groups WHERE id = '${groupId}'`);
    db.exec(`DELETE FROM users WHERE id = '${userId}'`);
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(groupId, 'Test', Date.now());
    db.query(
      `INSERT INTO users (id, username, display_name, password_hash, accent_color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, 'tester', 'Tester', 'x', '#000', Date.now());
  });

  function seed(path: string, title: string, body: PmDoc): void {
    const ydoc = prosemirrorJSONToYDoc(getPmSchema(), body, 'default');
    ydoc.getText('title').insert(0, title);
    ydoc.getMap('drawing-strokes-v3').set('s1', 'stroke');
    getDb()
      .query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                            yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                            created_at, created_by)
         VALUES (?, ?, ?, ?, ?, '', '', ?, '{}', 0, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), groupId, path, title, JSON.stringify(body), Y.encodeStateAsUpdate(ydoc),
           Date.now(), userId, Date.now(), userId);
  }

  function row(path: string): { content_json: string; content_md: string; title: string; yjs_state: Uint8Array } {
    return getDb()
      .query<{ content_json: string; content_md: string; title: string; yjs_state: Uint8Array }, [string, string]>(
        'SELECT content_json, content_md, title, yjs_state FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, path)!;
  }

  function linksFrom(path: string): string[] {
    return getDb()
      .query<{ to_path: string }, [string, string]>(
        'SELECT to_path FROM note_links WHERE group_id = ? AND from_path = ? ORDER BY to_path',
      )
      .all(groupId, path)
      .map((r) => r.to_path);
  }

  it('writes a History entry to content_json, content_md, yjs_state and note_links', async () => {
    seed(PATH, 'Bram', doc(paragraph(text('Runs the Mill inn.'))));

    const result = await applyNoteEdit({
      groupId,
      path: PATH,
      userId,
      edit: (body) => addHistoryEntry(body, { ...SESSION, text: 'Served the party ale.' }),
    });

    expect(result).toEqual({ status: 'applied' });
    const stored = row(PATH);
    const json = JSON.parse(stored.content_json) as PmDoc;
    expect(JSON.stringify(json)).toContain('Served the party ale.');
    expect(json.content?.[0]).toEqual(paragraph(text('Runs the Mill inn.')));
    expect(stored.content_md).toBe(
      'Runs the Mill inn.\n\n## History\n\n- [[Campaigns/c1/Sessions/Session 12.md]]: Served the party ale.\n',
    );
    expect(stored.title).toBe('Bram');
    expect(linksFrom(PATH)).toEqual([SESSION.sessionPath]);

    const live = new Y.Doc();
    Y.applyUpdate(live, stored.yjs_state);
    expect(yDocToProsemirrorJSON(live, 'default')).toEqual(json);
    expect(live.getMap('drawing-strokes-v3').get('s1')).toBe('stroke');
  });

  it('links a mention in a Session log and records the edge', async () => {
    const LOG = SESSION.sessionPath;
    seed(LOG, 'Session 12', doc(paragraph(text('We drank with Bram.'))));

    const result = await applyNoteEdit({
      groupId,
      path: LOG,
      userId,
      edit: (body) => linkMention(body, { text: 'Bram', targetPath: PATH }),
    });

    expect(result).toEqual({ status: 'applied' });
    expect(row(LOG).content_md).toBe('We drank with [[Campaigns/c1/People/Bram.md]].\n');
    expect(linksFrom(LOG)).toEqual([PATH]);
  });

  it('writes nothing for an unchanged edit', async () => {
    seed(PATH, 'Bram', doc(paragraph(text('Nothing to link.'))));
    const before = row(PATH);

    const result = await applyNoteEdit({
      groupId,
      path: PATH,
      userId,
      edit: (body) => linkMention(body, { text: 'Bram', targetPath: 'Elsewhere.md' }),
    });

    expect(result).toEqual({ status: 'unchanged' });
    expect(row(PATH)).toEqual(before);
  });

  it('reports a missing note', async () => {
    const result = await applyNoteEdit({
      groupId,
      path: 'Nope.md',
      userId,
      edit: (body) => addHistoryEntry(body, { ...SESSION, text: 'x' }),
    });

    expect(result).toEqual({ status: 'not_found' });
  });
});
