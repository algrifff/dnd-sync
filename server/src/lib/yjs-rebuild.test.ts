// Coverage for the round-three adversarial-review fixes in
// rebuildYjsState() and its call sites:
//
//  - NEW-5: a corrupt/truncated `existingState` blob must not throw —
//    it should degrade to a fresh Y.Doc instead of aborting the caller
//    mid-transaction.
//  - NIT-2: `title: ''` vs `title: undefined` must behave as documented
//    in yjs-rebuild.ts (undefined leaves the title alone; an explicit
//    '' wholesale-replaces it, same as any other string — callers that
//    want "don't touch unless we have one" pass `title || undefined`).
//  - NEW-4: repeated no-op `deriveFolderIndex` calls must not grow
//    `yjs_state` — each rebuild mints a fresh random Y.Doc clientID, so
//    without the short-circuit in campaign-index.ts, a byte-identical
//    rebuild still appends a permanent state-vector entry forever.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { getPmSchema } from './pm-schema';
import { rebuildYjsState } from './yjs-rebuild';
import { deriveFolderIndex } from './campaign-index';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

function doc(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

describe('rebuildYjsState — corrupt existing state (NEW-5)', () => {
  it('does not throw on a truncated/corrupt existingState and falls back to a fresh doc', () => {
    const schema = getPmSchema();
    // Not valid Yjs update encoding — decoding should overrun the
    // buffer and throw inside Y.applyUpdate.
    const corrupt = new Uint8Array([9, 255, 255, 255, 255, 255, 255, 255, 255, 255]);

    let state: Uint8Array | undefined;
    expect(() => {
      state = rebuildYjsState(schema, corrupt, doc('hello'), 'Title');
    }).not.toThrow();

    expect(state).toBeDefined();
    // Fresh doc: decodes cleanly and carries only the new body/title —
    // no leftover (garbage) roots from the corrupt blob.
    const ydoc = new Y.Doc();
    expect(() => Y.applyUpdate(ydoc, state!)).not.toThrow();
    expect(ydoc.getText('title').toString()).toBe('Title');
    expect(ydoc.getXmlFragment('default').toString()).toContain('hello');
  });
});

describe('rebuildYjsState — title contract (NIT-2)', () => {
  it('title: undefined leaves the existing Y.Text title untouched', () => {
    const schema = getPmSchema();
    const first = rebuildYjsState(schema, null, doc('body v1'), 'Original Title');

    const second = rebuildYjsState(schema, first, doc('body v2'), undefined);

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, second);
    expect(ydoc.getText('title').toString()).toBe('Original Title');
    expect(ydoc.getXmlFragment('default').toString()).toContain('body v2');
  });

  it('title: "" (explicit empty string) wipes the Y.Text title wholesale', () => {
    const schema = getPmSchema();
    const first = rebuildYjsState(schema, null, doc('body v1'), 'Original Title');

    // rebuildYjsState itself treats '' like any other provided string:
    // it replaces the title. Callers that want to preserve an existing
    // title when they have nothing new must pass `title || undefined`
    // themselves (see campaign-index.ts / move-rewrite.ts /
    // userCharacterSync.ts) — this test locks in that rebuildYjsState's
    // own contract is "wipe on ''", so a caller regression to passing
    // '' unconditionally is caught at the call site, not silently
    // absorbed here.
    const second = rebuildYjsState(schema, first, doc('body v2'), '');

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, second);
    expect(ydoc.getText('title').toString()).toBe('');
  });
});

describe('deriveFolderIndex — empty title does not wipe Y.Text title (NIT-2)', () => {
  const groupId = 'g_test_yjsrebuild_title';
  const userId = 'u_test_yjsrebuild_title';
  const folderPath = 'Campaigns/Demo/Loot';
  const indexPath = `${folderPath}/index.md`;

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM note_links');
    db.exec('DELETE FROM notes');
    db.exec('DELETE FROM notes_fts');
    db.exec('DELETE FROM folder_markers');
    db.exec(`DELETE FROM groups WHERE id = '${groupId}'`);
    db.exec(`DELETE FROM users WHERE id = '${userId}'`);
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
      groupId,
      'Test',
      Date.now(),
    );
    db.query(
      `INSERT INTO users (id, username, display_name, password_hash, accent_color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, 'tester-title', 'Tester', 'x', '#000', Date.now());
  });

  it('leaves a pre-existing Y.Text title alone when the DB title column reads empty', async () => {
    const schema = getPmSchema();
    // Simulate a note whose Y.Doc already carries a real title (e.g.
    // typed live by an editor) but whose `notes.title` column has since
    // gone empty (stale index, race, whatever) — the exact NIT-2
    // scenario: `indexRow.title` is '' while the Y root has content.
    const priorState = rebuildYjsState(schema, null, { type: 'doc', content: [] }, 'Loot Stash');

    getDb().query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, '', ?, '', '', ?, '{}', 0, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      groupId,
      indexPath,
      JSON.stringify({ type: 'doc', content: [] }),
      priorState,
      Date.now(),
      userId,
      Date.now(),
      userId,
    );

    await deriveFolderIndex(groupId, folderPath);

    const row = getDb()
      .query<{ yjs_state: Uint8Array | null }, [string, string]>(
        'SELECT yjs_state FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, indexPath);
    expect(row?.yjs_state).toBeTruthy();

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, row!.yjs_state!);
    expect(ydoc.getText('title').toString()).toBe('Loot Stash');
  });
});

describe('deriveFolderIndex — no-op growth guard (NEW-4)', () => {
  const groupId = 'g_test_yjsrebuild';
  const userId = 'u_test_yjsrebuild';
  const folderPath = 'Campaigns/Demo/Characters';
  const indexPath = `${folderPath}/index.md`;
  const childPath = `${folderPath}/Alice.md`;

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM note_links');
    db.exec('DELETE FROM notes');
    db.exec('DELETE FROM notes_fts');
    db.exec('DELETE FROM folder_markers');
    db.exec(`DELETE FROM groups WHERE id = '${groupId}'`);
    db.exec(`DELETE FROM users WHERE id = '${userId}'`);
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
      groupId,
      'Test',
      Date.now(),
    );
    db.query(
      `INSERT INTO users (id, username, display_name, password_hash, accent_color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, 'tester-growth', 'Tester', 'x', '#000', Date.now());

    // A stable child note so listDirectChildren's output — and thus the
    // rebuilt callout doc — is identical across every derive call.
    db.query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, '', '', ?, '{}', 0, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      groupId,
      childPath,
      'Alice',
      JSON.stringify({ type: 'doc', content: [] }),
      new Uint8Array(),
      Date.now(),
      userId,
      Date.now(),
      userId,
    );

    // The index note itself, seeded with no prior managed callout so
    // the first derive call inserts it. yjs_state starts empty — the
    // first rebuild builds a fresh doc, same as a brand-new note.
    db.query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, '', '', ?, '{}', 0, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      groupId,
      indexPath,
      'Characters',
      JSON.stringify({ type: 'doc', content: [] }),
      new Uint8Array(),
      Date.now(),
      userId,
      Date.now(),
      userId,
    );
  });

  function yjsStateLength(): number {
    const row = getDb()
      .query<{ yjs_state: Uint8Array | null }, [string, string]>(
        'SELECT yjs_state FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, indexPath);
    return row?.yjs_state?.length ?? 0;
  }

  it('does not grow yjs_state across 20 repeated no-op derives', async () => {
    // First call establishes the managed callout — content_json changes
    // from `{ content: [] }` to the callout doc, so this one is
    // expected to write and produce some baseline size.
    await deriveFolderIndex(groupId, folderPath);
    const baseline = yjsStateLength();
    expect(baseline).toBeGreaterThan(0);

    // Every subsequent call sees byte-identical children (same folder,
    // same single child note, untouched) so the rebuilt doc is
    // byte-identical too — the short-circuit in campaign-index.ts must
    // kick in and skip the write entirely.
    const sizes: number[] = [];
    for (let i = 0; i < 20; i++) {
      await deriveFolderIndex(groupId, folderPath);
      sizes.push(yjsStateLength());
    }

    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe(baseline);
  });
});
