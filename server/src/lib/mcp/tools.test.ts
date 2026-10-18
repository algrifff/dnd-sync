import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { setupTestDb, teardownTestDb } from '../test-utils';
import { DEFAULT_GROUP_ID } from '../users';
import { addRelation } from '../relations';
import { loadPendingWrapUp } from '../wrap-up';
import { bounded, MCP_TOOLS, runTool, type McpContext } from './tools';

const viewer: McpContext = { groupId: DEFAULT_GROUP_ID, role: 'viewer' };
const editor: McpContext = { groupId: DEFAULT_GROUP_ID, role: 'editor' };
const admin: McpContext = { groupId: DEFAULT_GROUP_ID, role: 'admin' };

const PUBLIC = 'Campaigns/Dragon Heist/People/Volo.md';
const SECRET = 'Campaigns/Dragon Heist/People/Xanathar.md';
const PRIVATE = 'Campaigns/Dragon Heist/Lore/Owner Plans.md';

function seedNote(opts: {
  path: string;
  body: string;
  kind?: string;
  dmOnly?: boolean;
  gmOnly?: boolean;
  groupId?: string;
}): void {
  const title = opts.path.replace(/\.md$/, '').split('/').pop()!;
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', ?, ?, NULL, ?, 0, ?, NULL, ?, NULL, ?, ?)`,
    )
    .run(
      randomUUID(),
      opts.groupId ?? DEFAULT_GROUP_ID,
      opts.path,
      title,
      opts.body,
      opts.body,
      JSON.stringify(opts.kind ? { kind: opts.kind } : {}),
      Date.now(),
      Date.now(),
      opts.dmOnly ? 1 : 0,
      opts.gmOnly ? 1 : 0,
    );
}

function link(from: string, to: string): void {
  getDb()
    .query('INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)')
    .run(DEFAULT_GROUP_ID, from, to);
}

beforeAll(() => {
  setupTestDb();
  getDb()
    .query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(DEFAULT_GROUP_ID, 'dragon-heist', 'Dragon Heist', 'Campaigns/Dragon Heist', Date.now());
  seedNote({ path: PUBLIC, body: 'Volothamp Geddarm, a famous chronicler of Waterdeep.', kind: 'person' });
  seedNote({ path: SECRET, body: 'The Xanathar is secretly a beholder.', kind: 'person', dmOnly: true });
  seedNote({ path: PRIVATE, body: 'Owner plans: the Xanathar betrays everyone.', kind: 'lore', gmOnly: true });
  seedNote({ path: 'Campaigns/Dragon Heist/Items/Stone of Golorr.md', body: 'An aboleth artifact.', kind: 'item' });
  link(SECRET, PUBLIC);
  link(PRIVATE, PUBLIC);
  link(PUBLIC, SECRET);
  link(PUBLIC, 'Campaigns/Dragon Heist/Items/Stone of Golorr.md');
});
afterAll(() => teardownTestDb());

describe('tool registry', () => {
  it('exposes the five read tools and the two Wrap-up tools', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      'list_campaigns',
      'browse_notes',
      'search_notes',
      'read_note',
      'note_neighbors',
      'wrap_up_context',
      'submit_wrap_up',
    ]);
  });

  it('rejects arguments that fail the tool schema without running it', () => {
    const r = runTool('note_neighbors', admin, { path: PUBLIC, depth: 3 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('depth');
  });
});

describe('list_campaigns', () => {
  it('lists slug, name and folder', () => {
    const r = runTool('list_campaigns', viewer, {});
    expect(r.text).toContain('Dragon Heist (slug: dragon-heist)');
    expect(r.text).toContain('Campaigns/Dragon Heist');
  });
});

describe('read_note', () => {
  it('returns title, path, kind, frontmatter, body and links for a visible note', () => {
    const r = runTool('read_note', viewer, { path: PUBLIC });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('# Volo');
    expect(r.text).toContain(`path: ${PUBLIC}`);
    expect(r.text).toContain('kind: person');
    expect(r.text).toContain('"kind": "person"');
    expect(r.text).toContain('famous chronicler');
    expect(r.text).toContain('Stone of Golorr');
  });

  it('accepts the path without the .md suffix', () => {
    const r = runTool('read_note', viewer, { path: PUBLIC.replace(/\.md$/, '') });
    expect(r.isError).toBeUndefined();
  });

  it('reports a Secret note as not found to a viewer, and shows it to an editor', () => {
    expect(runTool('read_note', viewer, { path: SECRET })).toEqual({ text: `Note not found: ${SECRET}`, isError: true });
    expect(runTool('read_note', editor, { path: SECRET }).text).toContain('beholder');
  });

  it('reports a Private note as not found to an editor, and shows it to the owner', () => {
    expect(runTool('read_note', editor, { path: PRIVATE }).isError).toBe(true);
    expect(runTool('read_note', admin, { path: PRIVATE }).text).toContain('betrays');
  });

  it('omits hidden notes from links and backlinks', () => {
    const asViewer = runTool('read_note', viewer, { path: PUBLIC }).text;
    expect(asViewer).not.toContain('Xanathar');
    expect(asViewer).not.toContain('Owner Plans');

    const asEditor = runTool('read_note', editor, { path: PUBLIC }).text;
    expect(asEditor).toContain('Xanathar');
    expect(asEditor).not.toContain('Owner Plans');

    const asAdmin = runTool('read_note', admin, { path: PUBLIC }).text;
    expect(asAdmin).toContain('Owner Plans');
  });

  it('is scoped to the world in the context', () => {
    expect(runTool('read_note', { groupId: 'other-world', role: 'admin' }, { path: PUBLIC }).isError).toBe(true);
  });
});

describe('browse_notes', () => {
  it('lists only what the role may see', () => {
    const asViewer = runTool('browse_notes', viewer, {}).text;
    expect(asViewer).toContain('Volo');
    expect(asViewer).not.toContain('Xanathar');
    expect(asViewer).not.toContain('Owner Plans');

    const asAdmin = runTool('browse_notes', admin, {}).text;
    expect(asAdmin).toContain('Xanathar');
    expect(asAdmin).toContain('Owner Plans');
  });

  it('filters by folder and kind', () => {
    const r = runTool('browse_notes', admin, { folder: 'Campaigns/Dragon Heist/Items' }).text;
    expect(r).toContain('Stone of Golorr');
    expect(r).not.toContain('Volo');

    const byKind = runTool('browse_notes', admin, { kind: 'lore' }).text;
    expect(byKind).toContain('Owner Plans');
    expect(byKind).not.toContain('Volo');
  });

  it('paginates with next_cursor', () => {
    const first = runTool('browse_notes', admin, { limit: 1 }).text;
    const cursor = /next_cursor: (.+)$/m.exec(first)?.[1];
    expect(cursor).toBeTruthy();
    const second = runTool('browse_notes', admin, { limit: 1, cursor }).text;
    expect(second).not.toContain(cursor!);
  });
});

describe('search_notes', () => {
  it('finds visible notes and never hidden ones', () => {
    const asViewer = runTool('search_notes', viewer, { query: 'Xanathar' }).text;
    expect(asViewer).not.toContain('Xanathar.md');
    expect(asViewer).not.toContain('Owner Plans');

    const asEditor = runTool('search_notes', editor, { query: 'Xanathar' }).text;
    expect(asEditor).toContain('Xanathar.md');
    expect(asEditor).not.toContain('Owner Plans');

    const asAdmin = runTool('search_notes', admin, { query: 'Xanathar' }).text;
    expect(asAdmin).toContain('Xanathar.md');
    expect(asAdmin).toContain('Owner Plans');
  });

  it('marks the matching words in the snippet', () => {
    const r = runTool('search_notes', viewer, { query: 'chronicler' }).text;
    expect(r).toContain('**chronicler**');
  });
});

describe('note_neighbors', () => {
  it('hides hidden notes from the neighbourhood and refuses a hidden centre', () => {
    const asViewer = runTool('note_neighbors', viewer, { path: PUBLIC }).text;
    expect(asViewer).toContain('Stone of Golorr');
    expect(asViewer).not.toContain('Xanathar');
    expect(asViewer).not.toContain('Owner Plans');

    expect(runTool('note_neighbors', viewer, { path: SECRET }).isError).toBe(true);

    const asEditor = runTool('note_neighbors', editor, { path: PUBLIC }).text;
    expect(asEditor).toContain('Xanathar');
    expect(asEditor).not.toContain('Owner Plans');
  });
});

describe('bounded', () => {
  it('cuts at a line boundary and keeps the next_cursor line', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `- Campaigns/X/Note ${i}.md — Note ${i}`);
    const text = lines.join('\n') + '\n\nnext_cursor: Campaigns/X/Note 1999.md';

    const out = bounded(text);

    expect(out.length).toBeLessThanOrEqual(24_100);
    expect(out).toContain('[truncated]');
    expect(out.endsWith('next_cursor: Campaigns/X/Note 1999.md')).toBe(true);
    expect(out.split('\n').filter((l) => l.startsWith('- ')).every((l) => /Note \d+\.md — Note \d+$/.test(l))).toBe(true);
  });
});

describe('Wrap-up tools', () => {
  const SESSION = 'Campaigns/Dragon Heist/Sessions/Session 2.md';
  const SECRET_SESSION = 'Campaigns/Dragon Heist/Sessions/GM Prep.md';
  const submitter = { ...viewer, scopes: ['notes:read', 'wrapup:submit'] };
  const mention = (path: string) => ({
    name: 'Volo',
    kind: 'person',
    match: { type: 'existing', path, certain: true },
    historyEntry: 'Offered a job.',
  });

  beforeAll(() => {
    seedNote({ path: SESSION, body: 'The party met Volo at the Yawning Portal.', kind: 'session' });
    seedNote({ path: SECRET_SESSION, body: 'Prep.', kind: 'session', dmOnly: true });
  });

  it('wrap_up_context returns the log and only the candidates the caller can see', () => {
    const r = runTool('wrap_up_context', viewer, { session_path: SESSION });

    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('met Volo at the Yawning Portal');
    expect(r.text).toContain(`- ${PUBLIC} — Volo [person]`);
    expect(r.text).not.toContain('Xanathar');
    expect(runTool('wrap_up_context', admin, { session_path: SESSION }).text).toContain('Xanathar');
  });

  it('answers not found for a Session the caller cannot see, and says so for a plain note', () => {
    expect(runTool('wrap_up_context', viewer, { session_path: SECRET_SESSION })).toMatchObject({ isError: true, text: expect.stringContaining('not found') });
    expect(runTool('wrap_up_context', viewer, { session_path: PUBLIC }).text).toContain('not a Session');
  });

  it('pages candidates with next_cursor', () => {
    const first = runTool('wrap_up_context', admin, { session_path: SESSION, limit: 1 }).text;
    const cursor = /next_cursor: (\d+)/.exec(first)?.[1];

    expect(cursor).toBe('1');
    expect(runTool('wrap_up_context', admin, { session_path: SESSION, limit: 1, cursor: 1 }).text).not.toBe(first);
  });

  it('submit_wrap_up stores a pending proposal and edits no note', () => {
    const before = getDb().query<{ content_json: string }, [string]>('SELECT content_json FROM notes WHERE path = ?').get(PUBLIC)!.content_json;

    const r = runTool('submit_wrap_up', submitter, { session_path: SESSION, mentions: [mention(PUBLIC)] });

    expect(r.isError).toBeUndefined();
    expect(loadPendingWrapUp(DEFAULT_GROUP_ID, 'viewer', SESSION)?.mentions).toHaveLength(1);
    expect(getDb().query<{ content_json: string }, [string]>('SELECT content_json FROM notes WHERE path = ?').get(PUBLIC)!.content_json).toBe(before);
  });

  it('submit_wrap_up refuses without the wrapup:submit scope', () => {
    const r = runTool('submit_wrap_up', viewer, { session_path: SESSION, mentions: [] });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('wrapup:submit');
  });

  it('submit_wrap_up reports a hidden target as not found and a Character-like target as invalid', () => {
    expect(runTool('submit_wrap_up', submitter, { session_path: SESSION, mentions: [mention(SECRET)] })).toMatchObject({ isError: true, text: expect.stringContaining('not found') });
    expect(runTool('submit_wrap_up', submitter, { session_path: SESSION, mentions: [mention(SESSION)] })).toMatchObject({ isError: true, text: expect.stringContaining('cannot take a History entry') });
  });

  it('submit_wrap_up rejects a malformed mention without running', () => {
    const r = runTool('submit_wrap_up', submitter, { session_path: SESSION, mentions: [{ name: 'x', kind: 'person' }] });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid arguments');
  });
});

describe('submit_wrap_up suggestions', () => {
  const SESSION = 'Campaigns/Dragon Heist/Sessions/Session 2.md';
  const CHARACTER = 'Campaigns/Dragon Heist/Characters/Brisa.md';
  const submitter = { ...viewer, scopes: ['notes:read', 'wrapup:submit'] };

  beforeAll(() => {
    seedNote({ path: CHARACTER, body: 'A rogue.', kind: 'character' });
  });

  it('stores a suggestion for a Character note', () => {
    const r = runTool('submit_wrap_up', submitter, {
      session_path: SESSION,
      mentions: [],
      suggestions: [{ characterPath: CHARACTER, story: 'Picked the lock.', items: [{ name: 'Lockpicks', quantity: 1 }] }],
    });

    expect(r.isError).toBeUndefined();
    expect(loadPendingWrapUp(DEFAULT_GROUP_ID, 'viewer', SESSION)?.suggestions).toHaveLength(1);
  });

  it('refuses a suggestion aimed at a note that is not a Character', () => {
    const r = runTool('submit_wrap_up', submitter, {
      session_path: SESSION,
      mentions: [],
      suggestions: [{ characterPath: PUBLIC, story: 'Hello.', items: [] }],
    });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('not a Character');
  });
});

describe('submit_wrap_up relations', () => {
  const SESSION = 'Campaigns/Dragon Heist/Sessions/Session 2.md';
  const STONE = 'Campaigns/Dragon Heist/Items/Stone of Golorr.md';
  const submitter = { ...viewer, scopes: ['notes:read', 'wrapup:submit'] };
  const mentions = [
    { name: 'Volo', kind: 'person', match: { type: 'existing', path: PUBLIC, certain: true }, historyEntry: 'Offered a job.' },
  ];
  const relation = { from: { type: 'mention', name: 'Volo' }, relation: 'owns', to: { type: 'existing', path: STONE }, note: 'He carries it.' };

  it('stores a relation between a mention and an existing note, and says nothing was written', () => {
    const r = runTool('submit_wrap_up', submitter, { session_path: SESSION, mentions, relations: [relation] });

    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('1 relation(s)');
    expect(r.text).toContain('Nothing has been written');
    expect(loadPendingWrapUp(DEFAULT_GROUP_ID, 'viewer', SESSION)?.relations).toMatchObject([
      { relation: 'owns', to: { type: 'existing', path: STONE }, note: 'He carries it.' },
    ]);
    expect(getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM note_relations').get()!.n).toBe(0);
  });

  it('refuses a relation naming a hidden note as not found, and one naming no mention as an error to fix', () => {
    const hidden = runTool('submit_wrap_up', submitter, {
      session_path: SESSION, mentions, relations: [{ ...relation, to: { type: 'existing', path: SECRET } }],
    });
    const nobody = runTool('submit_wrap_up', submitter, {
      session_path: SESSION, mentions, relations: [{ ...relation, from: { type: 'mention', name: 'Nobody' } }],
    });

    expect(hidden).toMatchObject({ isError: true, text: expect.stringContaining('not found') });
    expect(nobody).toMatchObject({ isError: true, text: expect.stringContaining('relations.0') });
  });

  it('rejects a type outside the shared list without running', () => {
    const r = runTool('submit_wrap_up', submitter, {
      session_path: SESSION, mentions, relations: [{ ...relation, relation: 'friends_with' }],
    });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid arguments');
  });

  it('tells the agent that related_to is the fallback and to propose only what the log states', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'submit_wrap_up')!;

    expect(tool.description).toContain('Use related_to only when no other type fits');
    expect(tool.description).toContain('only when the Session log states it');
  });
});

describe('Relationships in read_note and note_neighbors', () => {
  const ZHENT = 'Campaigns/Dragon Heist/Lore/Zhentarim.md';
  const STONE = 'Campaigns/Dragon Heist/Items/Stone of Golorr.md';

  beforeAll(() => {
    seedNote({ path: ZHENT, body: 'A black network.', kind: 'lore' });
    const base = { groupId: DEFAULT_GROUP_ID, sessionPath: null, userId: null };
    addRelation({ ...base, from: PUBLIC, relation: 'member_of', to: ZHENT });
    addRelation({ ...base, from: PUBLIC, relation: 'works_for', to: SECRET });
    addRelation({ ...base, from: PUBLIC, relation: 'related_to', to: PRIVATE });
  });

  it('read_note lists a Relationship from each end, read from that note\'s side', () => {
    expect(runTool('read_note', viewer, { path: PUBLIC }).text).toContain(`relationships:\n- member of: Zhentarim (${ZHENT})`);
    expect(runTool('read_note', viewer, { path: ZHENT }).text).toContain(`relationships:\n- has member: Volo (${PUBLIC})`);
  });

  it('read_note says (none) for a note with no Relationships', () => {
    expect(runTool('read_note', viewer, { path: STONE }).text).toContain('relationships:\n(none)');
  });

  it('read_note shows a Relationship to a Secret note to a Co-GM only, and to a Private note to the owner only', () => {
    const asViewer = runTool('read_note', viewer, { path: PUBLIC }).text;
    expect(asViewer).not.toContain('works for');
    expect(asViewer).not.toContain('Xanathar');
    expect(asViewer).not.toContain('related to');
    expect(asViewer).not.toContain('Owner Plans');

    const asEditor = runTool('read_note', editor, { path: PUBLIC }).text;
    expect(asEditor).toContain(`- works for: Xanathar (${SECRET})`);
    expect(asEditor).not.toContain('Owner Plans');

    expect(runTool('read_note', admin, { path: PUBLIC }).text).toContain(`- related to: Owner Plans (${PRIVATE})`);
  });

  it('note_neighbors labels a typed link with its type and leaves an untyped link alone', () => {
    const r = runTool('note_neighbors', editor, { path: PUBLIC }).text;

    expect(r).toContain(`- ${PUBLIC} -> ${ZHENT} [member of]`);
    expect(r).toContain(`- ${PUBLIC} -> ${SECRET} [works for]`);
    expect(r).toContain(`- ${SECRET} -> ${PUBLIC} [employs]`);
    expect(r.split('\n')).toContain(`- ${PUBLIC} -> ${STONE}`);
  });

  it('note_neighbors never labels a link to a note the caller cannot see', () => {
    const asViewer = runTool('note_neighbors', viewer, { path: PUBLIC }).text;

    expect(asViewer).toContain('[member of]');
    expect(asViewer).not.toContain('works for');
    expect(asViewer).not.toContain('Xanathar');
    expect(asViewer).not.toContain('Owner Plans');
  });

  it('note_neighbors filters to one type and the notes it reaches', () => {
    const r = runTool('note_neighbors', editor, { path: PUBLIC, relation: 'works_for' }).text;

    expect(r).toContain(`- ${PUBLIC} -> ${SECRET} [works for]`);
    expect(r).not.toContain('Zhentarim');
    expect(r).not.toContain('Stone of Golorr');
    expect(r).toContain('## Notes (1)');
  });

  it('note_neighbors matches a type from either end', () => {
    const fromTheGroup = runTool('note_neighbors', viewer, { path: ZHENT, relation: 'member_of' }).text;
    const fromTheEmployer = runTool('note_neighbors', editor, { path: SECRET, relation: 'works_for' }).text;

    expect(fromTheGroup).toContain(`- ${PUBLIC} -> ${ZHENT} [member of]`);
    expect(fromTheEmployer).toContain(`- ${SECRET} -> ${PUBLIC} [employs]`);
  });

  it('note_neighbors with a type nothing uses is empty, and an unknown type is refused', () => {
    expect(runTool('note_neighbors', editor, { path: PUBLIC, relation: 'owns' }).text).toContain('(no linked notes)');
    expect(runTool('note_neighbors', editor, { path: PUBLIC, relation: 'friends_with' }).isError).toBe(true);
  });
});

describe('read_note shares tags with', () => {
  const dir = 'Campaigns/Dragon Heist/Tag Test';
  const HUB = `${dir}/Hub.md`;
  const tag = (path: string, tags: string[], groupId = DEFAULT_GROUP_ID): void => {
    for (const t of tags) getDb().query('INSERT INTO tags (group_id, path, tag) VALUES (?, ?, ?)').run(groupId, path, t);
  };

  beforeAll(() => {
    for (const [name, tags, flags] of [
      ['Hub', ['a', 'b', 'c'], {}],
      ['Three', ['a', 'b', 'c'], {}],
      ['Two', ['a', 'b'], {}],
      ['One', ['c'], {}],
      ['Unrelated', ['zzz'], {}],
      ['Secret Twin', ['a', 'b', 'c'], { dmOnly: true }],
      ['Private Twin', ['a', 'b', 'c'], { gmOnly: true }],
    ] as const) {
      seedNote({ path: `${dir}/${name}.md`, body: name, ...flags });
      tag(`${dir}/${name}.md`, [...tags]);
    }
    getDb().query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run('tag-other-world', 'Other', Date.now());
    seedNote({ path: HUB, body: 'x', groupId: 'tag-other-world' });
    tag(HUB, ['a'], 'tag-other-world');
    for (let i = 0; i < 12; i++) {
      seedNote({ path: `${dir}/Bulk ${i}.md`, body: 'b' });
      tag(`${dir}/Bulk ${i}.md`, ['bulk']);
    }
    tag(HUB, ['bulk']);
  });

  const section = (ctx: McpContext): string[] => {
    const text = runTool('read_note', ctx, { path: HUB }).text;
    return text.slice(text.indexOf('shares tags with:')).split('\n').slice(1).filter((l) => l.startsWith('- '));
  };

  it('lists notes by how many tags they share, never the note itself', () => {
    const lines = section(viewer);

    expect(lines.slice(0, 2).map((l) => l.split(' (')[0])).toEqual(['- Three', '- Two']);
    expect(lines.some((l) => l.includes('Hub'))).toBe(false);
    expect(lines.some((l) => l.includes('Unrelated'))).toBe(false);
    expect(lines[0]).toContain(`(${dir}/Three.md)`);
  });

  it('caps the list at 10', () => {
    expect(section(admin)).toHaveLength(10);
  });

  it('leaves out Secret notes for a Player and Private notes for a Co-GM', () => {
    expect(section(viewer).join('\n')).not.toContain('Twin');
    expect(section(editor).join('\n')).toContain('Secret Twin');
    expect(section(editor).join('\n')).not.toContain('Private Twin');
    expect(section(admin).join('\n')).toContain('Private Twin');
  });

  it('only looks inside the caller\'s world', () => {
    const asOther = runTool('read_note', { groupId: 'tag-other-world', role: 'admin' }, { path: HUB }).text;

    expect(asOther).toContain('shares tags with:\n(none)');
  });
});
