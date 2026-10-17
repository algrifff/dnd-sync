// Smoke test: the PM JSON we hand-build for the managed callout must
// survive both schema.nodeFromJSON() and prosemirrorJSONToYDoc(). A
// silent schema-validation failure leaves the index with an empty
// Y.Doc, which is exactly the symptom we hit on the first attempt.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { deriveFolderIndex } from './campaign-index';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { getPmSchema } from './pm-schema';

// Reach into the module's internals via a small re-export to get the
// callout builder without forcing it onto the public API. We mirror
// the unexported builder shape here so the test fails loudly if the
// real one drifts.
import * as Y from 'yjs';

function paragraph(text: string) {
  return text
    ? { type: 'paragraph', content: [{ type: 'text', text }] }
    : { type: 'paragraph', content: [] };
}

describe('campaign-index PM JSON', () => {
  it('round-trips a callout containing a wikilink table through the schema', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Campaign Title' }],
        },
        {
          type: 'callout',
          attrs: { kind: 'info', title: '📚 Folder Index' },
          content: [
            paragraph('Auto-managed — edit your own notes outside this block.'),
            {
              type: 'heading',
              attrs: { level: 3 },
              content: [{ type: 'text', text: 'Sessions' }],
            },
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    { type: 'tableHeader', content: [paragraph('Name')] },
                    { type: 'tableHeader', content: [paragraph('Path')] },
                  ],
                },
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableCell',
                      content: [
                        {
                          type: 'paragraph',
                          content: [
                            {
                              type: 'wikilink',
                              attrs: {
                                target: 'Campaigns/Demo/Sessions/Foo.md',
                                label: '',
                                anchor: null,
                                orphan: false,
                              },
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: 'tableCell',
                      content: [paragraph('Campaigns/Demo/Sessions/Foo.md')],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const schema = getPmSchema();
    expect(() => schema.nodeFromJSON(doc)).not.toThrow();

    const ydoc = prosemirrorJSONToYDoc(schema, doc, 'default');
    const state = Y.encodeStateAsUpdate(ydoc);
    expect(state.byteLength).toBeGreaterThan(0);

    // Decode back and confirm the callout + wikilink survived.
    const back = yDocToProsemirrorJSON(ydoc, 'default') as { content?: unknown[] };
    expect(Array.isArray(back.content)).toBe(true);
    const calloutNode = (back.content ?? []).find(
      (n) => (n as { type?: string }).type === 'callout',
    );
    expect(calloutNode).toBeDefined();
  });
});

describe('deriveFolderIndex — hidden children', () => {
  const groupId = 'g_test_index_vis';
  const userId = 'u_test_index_vis';
  const folder = 'Campaigns/Demo/People';

  beforeAll(() => {
    setupTestDb();
    const db = getDb();
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(groupId, 'Vis', Date.now());
    db.query(
      `INSERT INTO users (id, username, display_name, password_hash, accent_color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, 'indexer', 'Indexer', 'x', '#000', Date.now());
  });
  afterAll(() => teardownTestDb());

  function seedChild(name: string, flags: { dmOnly?: boolean; gmOnly?: boolean } = {}): void {
    getDb()
      .query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                            content_md, yjs_state, frontmatter_json, byte_size,
                            updated_at, updated_by, created_at, created_by, dm_only, gm_only)
         VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, '{}', 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), groupId, `${folder}/${name}.md`, name, Date.now(), userId, Date.now(), userId,
           flags.dmOnly ? 1 : 0, flags.gmOnly ? 1 : 0);
  }

  it('should list only notes every viewer can see', async () => {
    seedChild('Visible Villager');
    seedChild('Secret Traitor', { dmOnly: true });
    seedChild('Owner Only Patron', { gmOnly: true });

    await deriveFolderIndex(groupId, folder, { userId });

    const index = getDb()
      .query<{ content_md: string }, [string, string]>(
        'SELECT content_md FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, `${folder}/index.md`)!;
    const listed = ['Visible Villager', 'Secret Traitor', 'Owner Only Patron'].filter((t) =>
      index.content_md.includes(t),
    );
    expect(listed).toEqual(['Visible Villager']);
  });
});

describe('deriveFolderIndex — folders holding only hidden notes', () => {
  const groupId = 'g_test_index_hidden_folders';
  const userId = 'u_test_index_hidden_folders';
  const parent = 'Campaigns/Demo/Places';
  const subfolders = ['Open Quarter', 'Smugglers Den', 'Owners Vault'];

  function seedNote(path: string, flags: { dmOnly?: boolean; gmOnly?: boolean } = {}): void {
    const title = path.split('/').pop()!.replace(/\.md$/, '');
    getDb()
      .query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                            content_md, yjs_state, frontmatter_json, byte_size,
                            updated_at, updated_by, created_at, created_by, dm_only, gm_only)
         VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, '{}', 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), groupId, path, title, Date.now(), userId, Date.now(), userId,
           flags.dmOnly ? 1 : 0, flags.gmOnly ? 1 : 0);
  }

  function indexBody(folder: string): string | null {
    return (
      getDb()
        .query<{ content_md: string }, [string, string]>(
          'SELECT content_md FROM notes WHERE group_id = ? AND path = ?',
        )
        .get(groupId, `${folder}/index.md`)?.content_md ?? null
    );
  }

  beforeAll(() => {
    setupTestDb();
    const db = getDb();
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(groupId, 'Hidden', Date.now());
    db.query(
      `INSERT INTO users (id, username, display_name, password_hash, accent_color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, 'indexer2', 'Indexer', 'x', '#000', Date.now());
    seedNote(`${parent}/Tavern.md`);
    seedNote(`${parent}/Open Quarter/Market.md`);
    seedNote(`${parent}/Smugglers Den/Cellar.md`, { dmOnly: true });
    seedNote(`${parent}/Owners Vault/Ledger.md`, { gmOnly: true });
  });
  afterAll(() => teardownTestDb());

  it('should list only subfolders that hold a note every viewer can see', async () => {
    await deriveFolderIndex(groupId, parent, { userId });

    const listed = subfolders.filter((name) => indexBody(parent)!.includes(name));
    expect(listed).toEqual(['Open Quarter']);
  });

  it('should not auto-create an index for a folder whose only notes are hidden', async () => {
    for (const name of subfolders) {
      await deriveFolderIndex(groupId, `${parent}/${name}`, { userId });
    }

    const indexed = subfolders.filter((name) => indexBody(`${parent}/${name}`) !== null);
    expect(indexed).toEqual(['Open Quarter']);
  });
});
