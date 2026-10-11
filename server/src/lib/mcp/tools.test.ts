import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { setupTestDb, teardownTestDb } from '../test-utils';
import { DEFAULT_GROUP_ID } from '../users';
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
  it('exposes exactly the five read-only tools', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      'list_campaigns',
      'browse_notes',
      'search_notes',
      'read_note',
      'note_neighbors',
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
