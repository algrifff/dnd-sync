// Regression tests for the C2 data-loss bug: entity_edit_content,
// backlink_create and note_write_section used to write
// `yjs_state = NULL`. Since NoteSurface.tsx binds Tiptap to the Y.Doc
// alone with no content fallback, a NULL state renders the note EMPTY
// for the next person who opens it — and their first keystroke
// persists that emptiness over content_json, destroying the body.
//
// Every one of these tools must now REBUILD yjs_state instead of
// nulling it. These tests seed a note with a real yjs_state + body,
// run the tool, and decode the resulting state to prove both the new
// content and the pre-existing body survived.
//
// entity_edit_sheet / inventory_add write only frontmatter_json (not
// part of the Y.Doc at all — see collab/derive.ts), so they must NOT
// touch yjs_state: those tests assert byte-for-byte equality instead.

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { Document } from '@hocuspocus/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { getPmSchema } from '@/lib/pm-schema';
import * as collabServer from '@/collab/server';
import type { ServerWriteToken } from '@/collab/server';
import { createTools, type ToolContext } from './tools';

// Snapshot the REAL exports into a plain object before any test runs
// `mock.module` on this specifier. Bun's `mock.module` mutates the
// live module namespace object IN PLACE rather than swapping in a new
// one — so `collabServer` (the `import * as` binding above) reflects
// whatever the most recent mock installed, permanently, for the rest
// of this process's module registry (including other test files that
// import '@/collab/server' afterwards). A "restore" that does
// `mock.module('@/collab/server', () => collabServer)` therefore just
// re-mocks with the ALREADY-MUTATED namespace — a no-op disguised as a
// restore. Freezing a copy here, while every export is still the real
// function, is what makes restoration actually work.
const ORIGINAL_COLLAB_SERVER = { ...collabServer };

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

const groupId = 'g_test_aitools';
const userId = 'u_test_aitools';

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM note_links');
  db.exec('DELETE FROM notes');
  db.exec('DELETE FROM notes_fts');
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
  ).run(userId, 'tester', 'Tester', 'x', '#000', Date.now());
});

function paragraph(text: string): Record<string, unknown> {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function heading(level: number, text: string): Record<string, unknown> {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

/** Build a real yjs_state blob the same way the production write
 *  paths do: prosemirrorJSONToYDoc for the body + a title Y.Text. */
function buildYjsState(title: string, pmDoc: Record<string, unknown>): Uint8Array {
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), pmDoc, 'default');
  if (title) ydoc.getText('title').insert(0, title);
  return Y.encodeStateAsUpdate(ydoc);
}

function seedNote(args: {
  path: string;
  title: string;
  pmDoc: Record<string, unknown>;
  contentMd: string;
  frontmatterJson?: string;
  gmOnly?: boolean;
}): void {
  const db = getDb();
  const state = buildYjsState(args.title, args.pmDoc);
  db.query(
    `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                        content_md, yjs_state, frontmatter_json, byte_size,
                        updated_at, updated_by, created_at, created_by, gm_only)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    groupId,
    args.path,
    args.title,
    JSON.stringify(args.pmDoc),
    args.contentMd,
    args.contentMd,
    state,
    args.frontmatterJson ?? '{}',
    args.contentMd.length,
    Date.now(),
    userId,
    Date.now(),
    userId,
    args.gmOnly ? 1 : 0,
  );
  db.query(
    'INSERT INTO notes_fts(path, group_id, title, content) VALUES (?, ?, ?, ?)',
  ).run(args.path, groupId, args.title, args.contentMd);
}

type NoteRow = {
  title: string;
  content_json: string;
  content_md: string;
  yjs_state: Uint8Array | null;
  frontmatter_json: string;
};

function readNote(path: string): NoteRow {
  const row = getDb()
    .query<NoteRow, [string, string]>(
      `SELECT title, content_json, content_md, yjs_state, frontmatter_json
         FROM notes WHERE group_id = ? AND path = ?`,
    )
    .get(groupId, path);
  if (!row) throw new Error(`seed missing: ${path}`);
  return row;
}

/** Decode a stored yjs_state blob back into PM JSON + the title text,
 *  the same way the client editor and derive.ts would. */
function decode(state: Uint8Array): { pm: { content?: unknown[] }; title: string } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return {
    pm: yDocToProsemirrorJSON(doc, 'default') as { content?: unknown[] },
    title: doc.getText('title').toString(),
  };
}

function flatText(pm: { content?: unknown[] }): string {
  const out: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  }
  for (const c of pm.content ?? []) walk(c);
  return out.join(' ');
}

/** `sessionRole` defaults to the most permissive plausible value for
 *  each collapsed `role`, so every EXISTING call site (which predates
 *  `sessionRole` and only ever passed `role`) keeps its prior
 *  behaviour unchanged. Tests that need to distinguish an admin from
 *  an editor — both of which collapse to `role: 'dm'` — pass
 *  `sessionRole` explicitly. */
function ctxFor(
  role: ToolContext['role'],
  sessionRole?: ToolContext['sessionRole'],
): ToolContext {
  const resolvedSessionRole: ToolContext['sessionRole'] =
    sessionRole ?? (role === 'dm' ? 'admin' : role === 'player' ? 'editor' : 'viewer');
  return {
    groupId,
    userId,
    role,
    sessionRole: resolvedSessionRole,
    gmNamespace: role === 'dm',
  };
}

// ── Concurrent-write-coordination regression tests (D2a / D4) ─────────
//
// There's no live WebSocket/Hocuspocus doc in this test environment, so
// `closeDocumentForWrite` is normally a no-op here (it early-returns
// when `collabServer.documents` has no entry for the path). To
// meaningfully test "content used to compute a write must be read
// AFTER the drain" (D4) and "reattached editors are evicted AFTER the
// write" (D2a), we substitute `closeDocumentForWrite` /
// `closeDocumentConnections` with instrumented versions via
// `mock.module`. Bun retroactively rewrites the live bindings that
// `tools.ts` already imported, so this affects the module under test
// without needing to re-import it.

/** Simulates a live editor's Hocuspocus flush landing on `path` DURING
 *  the server-side drain window. `applyFlush` performs a raw UPDATE to
 *  the note row — the same shape of write Hocuspocus's own `store()`
 *  does when the last connection drops — and runs it from inside a
 *  stand-in `closeDocumentForWrite`, i.e. genuinely BETWEEN the tool's
 *  existence check and its real content read. If a tool computed its
 *  next document from a read taken before this point (the old, buggy
 *  ordering), the flushed content would be silently discarded by the
 *  tool's own write. Restores the real module on the way out. */
async function withSimulatedConcurrentFlush(
  path: string,
  applyFlush: () => void,
  fn: () => unknown,
): Promise<unknown> {
  const realClose = ORIGINAL_COLLAB_SERVER.closeDocumentForWrite;
  // Must return the REAL token: the tool threads it into its
  // post-write `closeDocumentConnections(path, token)`, and a spy that
  // swallowed it would silently downgrade every one of these tests to
  // the tokenless flush path.
  const drainSpy = async (documentName: string): Promise<ServerWriteToken> => {
    if (documentName === path) applyFlush();
    return realClose(documentName);
  };
  mock.module('@/collab/server', () => ({ ...ORIGINAL_COLLAB_SERVER, closeDocumentForWrite: drainSpy }));
  try {
    return await fn();
  } finally {
    // Restore from the frozen snapshot, NOT from `collabServer` — see
    // the comment on ORIGINAL_COLLAB_SERVER above.
    mock.module('@/collab/server', () => ORIGINAL_COLLAB_SERVER);
  }
}

describe('withSimulatedConcurrentFlush — mock.module restore actually restores', () => {
  it('leaves the module namespace pointing at the real functions afterwards, not the spy', async () => {
    // Before: the live namespace binding must already be the real
    // function (nothing else has mocked it yet in this process).
    expect(collabServer.closeDocumentForWrite).toBe(ORIGINAL_COLLAB_SERVER.closeDocumentForWrite);

    let sawFlushDuring = false;
    await withSimulatedConcurrentFlush(
      'Test/RestoreProbe.md',
      () => { sawFlushDuring = true; },
      async () => {
        // During: the namespace must reflect the spy while the mock is active.
        expect(collabServer.closeDocumentForWrite).not.toBe(ORIGINAL_COLLAB_SERVER.closeDocumentForWrite);
      },
    );
    void sawFlushDuring; // this path doesn't touch the target doc — only proves during != after

    // After: with the buggy restore (`mock.module(spec, () => collabServer)`),
    // this would still be the spy, because by the time `finally` runs,
    // `collabServer` (the mutated-in-place namespace) already IS the
    // spy version — re-mocking with it just reinstalls the spy. The
    // fixed restore uses the frozen ORIGINAL_COLLAB_SERVER snapshot
    // instead, so this must be back to the real function.
    expect(collabServer.closeDocumentForWrite).toBe(ORIGINAL_COLLAB_SERVER.closeDocumentForWrite);
  });
});

describe('entity_edit_content — read-after-drain invariant (D4)', () => {
  it('incorporates a concurrent flush that lands during the drain instead of clobbering it', async () => {
    const path = 'Test/Concurrent.md';
    seedNote({
      path,
      title: 'Concurrent',
      pmDoc: { type: 'doc', content: [paragraph('Original body.')] },
      contentMd: 'Original body.',
    });

    const tools = createTools(ctxFor('player'));
    const result = await withSimulatedConcurrentFlush(
      path,
      () => {
        const flushedDoc = {
          type: 'doc',
          content: [paragraph('Original body.'), paragraph('Flushed concurrent sentence.')],
        };
        const flushedMd = 'Original body.\n\nFlushed concurrent sentence.';
        const state = buildYjsState('Concurrent', flushedDoc);
        getDb()
          .query(
            `UPDATE notes SET content_json=?, content_text=?, content_md=?, yjs_state=?
               WHERE group_id=? AND path=?`,
          )
          .run(
            JSON.stringify(flushedDoc),
            'Original body. Flushed concurrent sentence.',
            flushedMd,
            state,
            groupId,
            path,
          );
      },
      () =>
        tools.entity_edit_content.execute!(
          { path, content: 'AI added paragraph.' },
          { toolCallId: 't6', messages: [] },
        ),
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const row = readNote(path);
    const { pm } = decode(row.yjs_state!);
    const text = flatText(pm);
    // Both the concurrent flush AND the tool's own addition must
    // survive — neither should clobber the other.
    expect(text).toContain('Flushed concurrent sentence');
    expect(text).toContain('AI added paragraph');
    expect(row.content_md).toContain('Flushed concurrent sentence');
    expect(row.content_md).toContain('AI added paragraph');
  });
});

describe('backlink_create — read-after-drain invariant (D4)', () => {
  it('links against post-flush content instead of a stale pre-drain copy', async () => {
    const fromPath = 'Test/BobConcurrent.md';
    seedNote({
      path: fromPath,
      title: 'BobConcurrent',
      pmDoc: { type: 'doc', content: [paragraph('Bob is a travelling merchant.')] },
      contentMd: 'Bob is a travelling merchant.',
    });

    const tools = createTools(ctxFor('player'));
    const result = await withSimulatedConcurrentFlush(
      fromPath,
      () => {
        const flushedDoc = {
          type: 'doc',
          content: [paragraph('Bob is a travelling merchant.'), paragraph('Bob got promoted.')],
        };
        const flushedMd = 'Bob is a travelling merchant.\n\nBob got promoted.';
        const state = buildYjsState('BobConcurrent', flushedDoc);
        getDb()
          .query(
            `UPDATE notes SET content_json=?, content_text=?, content_md=?, yjs_state=?
               WHERE group_id=? AND path=?`,
          )
          .run(
            JSON.stringify(flushedDoc),
            'Bob is a travelling merchant. Bob got promoted.',
            flushedMd,
            state,
            groupId,
            fromPath,
          );
      },
      () =>
        tools.backlink_create.execute!(
          { fromPath, toPath: 'Test/CarolConcurrent.md', label: undefined },
          { toolCallId: 't7', messages: [] },
        ),
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const row = readNote(fromPath);
    // The flushed sentence must survive, and the new wikilink must be
    // appended on top of it — not the stale pre-drain body.
    expect(row.content_md).toContain('Bob got promoted');
    expect(row.content_md).toContain('[[CarolConcurrent');
  });
});

describe('note_write_section — read-after-drain invariant (D4)', () => {
  it('splices the section against post-flush content instead of a stale pre-drain copy', async () => {
    const path = 'Test/DungeonConcurrent.md';
    seedNote({
      path,
      title: 'DungeonConcurrent',
      pmDoc: {
        type: 'doc',
        content: [
          paragraph('Intro paragraph.'),
          heading(2, 'Combat Notes'),
          paragraph('Old combat notes.'),
        ],
      },
      contentMd: 'Intro paragraph.\n\n## Combat Notes\n\nOld combat notes.',
    });

    const tools = createTools(ctxFor('dm'));
    const result = await withSimulatedConcurrentFlush(
      path,
      () => {
        // The live editor changed the INTRO paragraph (outside the
        // targeted section) while the tool call was in flight.
        const flushedDoc = {
          type: 'doc',
          content: [
            paragraph('Intro paragraph EDITED BY LIVE USER.'),
            heading(2, 'Combat Notes'),
            paragraph('Old combat notes.'),
          ],
        };
        const flushedMd =
          'Intro paragraph EDITED BY LIVE USER.\n\n## Combat Notes\n\nOld combat notes.';
        const state = buildYjsState('DungeonConcurrent', flushedDoc);
        getDb()
          .query(
            `UPDATE notes SET content_json=?, content_text=?, content_md=?, yjs_state=?
               WHERE group_id=? AND path=?`,
          )
          .run(
            JSON.stringify(flushedDoc),
            'Intro paragraph EDITED BY LIVE USER. Combat Notes Old combat notes.',
            flushedMd,
            state,
            groupId,
            path,
          );
      },
      () =>
        tools.note_write_section.execute!(
          { path, section: 'Combat Notes', content: 'Fresh combat notes v2.' },
          { toolCallId: 't8', messages: [] },
        ),
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const row = readNote(path);
    // The live edit to the intro (untouched by this tool call) must
    // survive, and the section splice must have targeted the
    // post-flush heading position, not a stale pre-drain one.
    expect(row.content_md).toContain('Intro paragraph EDITED BY LIVE USER');
    expect(row.content_md).toContain('Fresh combat notes v2');
    expect(row.content_md).not.toContain('Old combat notes');
  });
});

// ── NEW-1: a tool that early-returns must not strand its write token ──
//
// Every server-write call site takes a token from
// `closeDocumentForWrite` and is wrapped in
// `try { … } finally { releaseServerWrite(token) }`. Without the
// `finally`, a branch that returns before the post-write evict leaves
// the path armed, and the NEXT eviction from any caller at all —
// `notes/visibility`, a folder delete, a campaign delete — silently
// goes destructive and drops a live editor's unflushed keystrokes.
//
// `backlink_create`'s post-drain "the link is already there" branch is
// the cleanest instance: it deliberately returns WITHOUT evicting (N7),
// so it is pure leak unless the token is released. Reached here by
// having the simulated concurrent flush insert the very link the tool
// was about to add.
//
// Observable, as in collab/derive.test.ts: a pending
// `onStoreDocument-<path>` timer is exactly what an eviction flushes,
// and the destructive path cancels it.

describe('backlink_create — releases its write token on the post-drain no-op branch (NEW-1)', () => {
  it('leaves a later unrelated eviction on the same path non-destructive', async () => {
    const path = 'Test/BobAlreadyLinked.md';
    seedNote({
      path,
      title: 'BobAlreadyLinked',
      pmDoc: { type: 'doc', content: [paragraph('Bob is a travelling merchant.')] },
      contentMd: 'Bob is a travelling merchant.',
    });

    const hocuspocus = ORIGINAL_COLLAB_SERVER.collabServer;
    const storeId = `onStoreDocument-${path}`;
    hocuspocus.documents.set(path, new Document(path));
    void hocuspocus.debouncer.debounce(storeId, () => undefined, 5_000, 10_000);

    try {
      const tools = createTools(ctxFor('player'));
      // Act 1 — the concurrent flush lands the link first, so the tool
      // takes its post-drain no-op return.
      const result = await withSimulatedConcurrentFlush(
        path,
        () => {
          getDb()
            .query('UPDATE notes SET content_md=? WHERE group_id=? AND path=?')
            .run('Bob is a travelling merchant.\n\n[[Carol]]', groupId, path);
        },
        () =>
          tools.backlink_create.execute!(
            { fromPath: path, toPath: 'Test/Carol.md', label: undefined },
            { toolCallId: 't11', messages: [] },
          ),
      );
      expect((result as { ok: boolean }).ok).toBe(true);
      // Nothing was written — one link, not two.
      expect(readNote(path).content_md).toBe('Bob is a travelling merchant.\n\n[[Carol]]');

      // Act 2 — an unrelated caller evicts the same path, tokenless.
      await ORIGINAL_COLLAB_SERVER.closeDocumentConnections(path);

      // Assert — flush semantics preserved. If the tool had stranded
      // its token, this eviction would have consumed it and cancelled
      // the live editor's pending store instead.
      expect(hocuspocus.debouncer.isDebounced(storeId)).toBe(true);
    } finally {
      hocuspocus.documents.delete(path);
      void hocuspocus.debouncer.debounce(storeId, () => undefined, 0, 0);
    }
  });
});

describe('entity_edit_content — evicts reattached editors AFTER the write (D2a)', () => {
  it('calls closeDocumentConnections exactly once, targeting the written path', async () => {
    const path = 'Test/EvictAfter.md';
    seedNote({
      path,
      title: 'EvictAfter',
      pmDoc: { type: 'doc', content: [paragraph('Body.')] },
      contentMd: 'Body.',
    });

    const realEvict = ORIGINAL_COLLAB_SERVER.closeDocumentConnections;
    const calls: Array<{ documentName: string; hadToken: boolean }> = [];
    const evictSpy = async (
      documentName: string,
      token?: ServerWriteToken,
    ): Promise<void> => {
      calls.push({ documentName, hadToken: token !== undefined });
      return realEvict(documentName, token);
    };
    mock.module('@/collab/server', () => ({ ...ORIGINAL_COLLAB_SERVER, closeDocumentConnections: evictSpy }));
    try {
      const tools = createTools(ctxFor('player'));
      const result = await tools.entity_edit_content.execute!(
        { path, content: 'More.' },
        { toolCallId: 't9', messages: [] },
      );
      expect((result as { ok: boolean }).ok).toBe(true);
      // Exactly one post-write evict, on the written path, AND it must
      // carry the token from the tool's own `closeDocumentForWrite` —
      // without it the evict lets Hocuspocus flush the pre-write doc
      // straight back over the row the tool just wrote.
      expect(calls).toEqual([{ documentName: path, hadToken: true }]);
    } finally {
      // Restore from the frozen snapshot — see ORIGINAL_COLLAB_SERVER.
      mock.module('@/collab/server', () => ORIGINAL_COLLAB_SERVER);
    }
  });
});

describe('note_write_section — its post-write evict is actually destructive', () => {
  it('cancels the live editor\'s pending store rather than flushing it', async () => {
    // note_write_section is the only call site that takes the token in
    // one function and consumes it in another: it owns the
    // `try/finally`, but `writeFullContent` does the write and the
    // evict. Dropping the token on the way through that hand-off —
    // `closeDocumentConnections(path)` instead of
    // `closeDocumentConnections(path, token)` — leaves every other test
    // in this file green while silently restoring the flush-on-evict
    // that lets a live editor's pre-write document land back on top of
    // the section write. Verified: that one-word change fails this test
    // and nothing else.
    //
    // It has to assert the EFFECT, not the call. Spying on
    // `closeDocumentConnections` and checking that some token argument
    // arrived is too weak — a revoked token is still an argument. The
    // only thing that separates the two outcomes is whether
    // Hocuspocus's pending store survived (flush → clobber) or was
    // cancelled (discard → correct).
    const path = 'Test/SectionEvict.md';
    seedNote({
      path,
      title: 'SectionEvict',
      pmDoc: {
        type: 'doc',
        content: [heading(2, 'Combat Notes'), paragraph('Old combat notes.')],
      },
      contentMd: '## Combat Notes\n\nOld combat notes.',
    });

    const hocuspocus = ORIGINAL_COLLAB_SERVER.collabServer;
    const storeId = `onStoreDocument-${path}`;
    hocuspocus.documents.set(path, new Document(path));
    void hocuspocus.debouncer.debounce(storeId, () => undefined, 5_000, 10_000);

    try {
      const tools = createTools(ctxFor('dm'));
      const result = await tools.note_write_section.execute!(
        { path, section: 'Combat Notes', content: 'Fresh combat notes.' },
        { toolCallId: 't12', messages: [] },
      );
      expect((result as { ok: boolean }).ok).toBe(true);
      expect(hocuspocus.debouncer.isDebounced(storeId)).toBe(false);
    } finally {
      hocuspocus.documents.delete(path);
      void hocuspocus.debouncer.debounce(storeId, () => undefined, 0, 0);
    }
  });
});

describe('entity_edit_content — never leaves yjs_state NULL', () => {
  it('rebuilds yjs_state with both the appended paragraph and the pre-existing body', async () => {
    const path = 'Test/Alice.md';
    seedNote({
      path,
      title: 'Alice',
      pmDoc: { type: 'doc', content: [paragraph('Existing body text.')] },
      contentMd: 'Existing body text.',
    });

    const tools = createTools(ctxFor('player'));
    const result = await tools.entity_edit_content.execute!(
      { path, content: 'A brand new paragraph.' },
      { toolCallId: 't1', messages: [] },
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const row = readNote(path);
    expect(row.yjs_state).not.toBeNull();

    const { pm, title } = decode(row.yjs_state!);
    const text = flatText(pm);
    expect(text).toContain('brand new paragraph');
    expect(text).toContain('Existing body text');
    expect(title).toBe('Alice');
  });
});

describe('backlink_create — never leaves yjs_state NULL', () => {
  it('rebuilds yjs_state with the wikilink and the pre-existing body, and inserts note_links', async () => {
    const fromPath = 'Test/Bob.md';
    seedNote({
      path: fromPath,
      title: 'Bob',
      pmDoc: { type: 'doc', content: [paragraph('Bob is a travelling merchant.')] },
      contentMd: 'Bob is a travelling merchant.',
    });

    const tools = createTools(ctxFor('player'));
    const result = await tools.backlink_create.execute!(
      { fromPath, toPath: 'Test/Carol.md', label: undefined },
      { toolCallId: 't2', messages: [] },
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const row = readNote(fromPath);
    expect(row.yjs_state).not.toBeNull();

    const { pm, title } = decode(row.yjs_state!);
    const text = flatText(pm);
    expect(text).toContain('Bob is a travelling merchant');
    expect(title).toBe('Bob');

    const link = getDb()
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n FROM note_links
           WHERE group_id = ? AND from_path = ? AND to_path = ?`,
      )
      .get(groupId, fromPath, 'Test/Carol.md');
    expect(link?.n).toBe(1);
  });
});

describe('note_write_section — never leaves yjs_state NULL', () => {
  it('rebuilds yjs_state, replacing only the targeted section and preserving the rest', async () => {
    const path = 'Test/Dungeon.md';
    seedNote({
      path,
      title: 'Dungeon',
      pmDoc: {
        type: 'doc',
        content: [
          paragraph('Intro paragraph.'),
          heading(2, 'Combat Notes'),
          paragraph('Old combat notes.'),
        ],
      },
      contentMd: 'Intro paragraph.\n\n## Combat Notes\n\nOld combat notes.',
    });

    const tools = createTools(ctxFor('dm'));
    const result = await tools.note_write_section.execute!(
      { path, section: 'Combat Notes', content: 'Fresh combat notes.' },
      { toolCallId: 't3', messages: [] },
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const row = readNote(path);
    expect(row.yjs_state).not.toBeNull();

    const { pm, title } = decode(row.yjs_state!);
    const text = flatText(pm);
    expect(text).toContain('Fresh combat notes');
    expect(text).toContain('Intro paragraph');
    expect(text).not.toContain('Old combat notes');
    expect(title).toBe('Dungeon');
  });
});

// ── N1 regression: rebuild must preserve other Y roots ────────────────
//
// `prosemirrorJSONToYDoc` builds a brand-new Y.Doc containing ONLY the
// `default` XmlFragment + a fresh `title` Y.Text. A real note's Y.Doc
// also carries `drawing-strokes-v3` (DrawingOverlay.tsx's live
// freehand-annotation Y.Map<Stroke>) and, for canvas notes,
// `excalidraw-elements` / `excalidraw-appState`. Any write path that
// rebuilds yjs_state from PM JSON alone silently drops these the first
// time the AI (or any other rebuild site) touches an annotated note.
//
// This test seeds a note whose yjs_state has a populated
// `drawing-strokes-v3` map (mirroring the shape DrawingOverlay.tsx
// writes — see its `Stroke` type) alongside the normal body + title,
// runs entity_edit_content, and asserts the stroke data survived
// alongside the new paragraph and the pre-existing body/title.

type Stroke = {
  id: string;
  userId: string;
  color: string;
  points: Array<[number, number]>;
};

function buildYjsStateWithDrawing(
  title: string,
  pmDoc: Record<string, unknown>,
  strokes: Record<string, Stroke>,
): Uint8Array {
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), pmDoc, 'default');
  if (title) ydoc.getText('title').insert(0, title);
  const strokesMap = ydoc.getMap<Stroke>('drawing-strokes-v3');
  for (const [id, stroke] of Object.entries(strokes)) {
    strokesMap.set(id, stroke);
  }
  return Y.encodeStateAsUpdate(ydoc);
}

describe('entity_edit_content — preserves other Y roots on rebuild (N1)', () => {
  it('keeps drawing-strokes-v3 intact alongside the new paragraph, old body, and title', async () => {
    const path = 'Test/Annotated.md';
    const stroke: Stroke = {
      id: 'stroke-1',
      userId: 'u_test_aitools',
      color: '#ff0000',
      points: [[10, 20], [30, 40], [50, 60]],
    };

    const db = getDb();
    const state = buildYjsStateWithDrawing(
      'Annotated',
      { type: 'doc', content: [paragraph('Pre-existing annotated body.')] },
      { [stroke.id]: stroke },
    );
    db.query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), groupId, path, 'Annotated',
      JSON.stringify({ type: 'doc', content: [paragraph('Pre-existing annotated body.')] }),
      'Pre-existing annotated body.', 'Pre-existing annotated body.',
      state, '{}', 'Pre-existing annotated body.'.length,
      Date.now(), userId, Date.now(), userId,
    );
    db.query(
      'INSERT INTO notes_fts(path, group_id, title, content) VALUES (?, ?, ?, ?)',
    ).run(path, groupId, 'Annotated', 'Pre-existing annotated body.');

    const tools = createTools(ctxFor('player'));
    const result = await tools.entity_edit_content.execute!(
      { path, content: 'AI appended paragraph.' },
      { toolCallId: 't10', messages: [] },
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const row = readNote(path);
    expect(row.yjs_state).not.toBeNull();

    const { pm, title } = decode(row.yjs_state!);
    const text = flatText(pm);
    expect(text).toContain('AI appended paragraph');
    expect(text).toContain('Pre-existing annotated body');
    expect(title).toBe('Annotated');

    // The critical assertion: the drawing layer must have survived the
    // rebuild untouched — this is what N1's bug destroys.
    const decodedDoc = new Y.Doc();
    Y.applyUpdate(decodedDoc, row.yjs_state!);
    const strokesMap = decodedDoc.getMap<Stroke>('drawing-strokes-v3');
    expect(strokesMap.size).toBe(1);
    const survivedStroke = strokesMap.get(stroke.id);
    expect(survivedStroke).toBeDefined();
    expect(survivedStroke?.color).toBe('#ff0000');
    expect(survivedStroke?.userId).toBe('u_test_aitools');
    expect(survivedStroke?.points).toEqual(stroke.points);
  });
});

describe('entity_edit_sheet — does not touch yjs_state', () => {
  it('changes frontmatter_json but leaves yjs_state byte-identical', async () => {
    const path = 'Test/Eve.md';
    seedNote({
      path,
      title: 'Eve',
      pmDoc: { type: 'doc', content: [paragraph('Eve is a rogue.')] },
      contentMd: 'Eve is a rogue.',
      frontmatterJson: '{}',
    });
    const before = readNote(path);

    const tools = createTools(ctxFor('dm'));
    const result = await tools.entity_edit_sheet.execute!(
      { path, updates: { alignment: 'chaotic neutral' } },
      { toolCallId: 't4', messages: [] },
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const after = readNote(path);
    expect(after.frontmatter_json).not.toBe(before.frontmatter_json);
    const fm = JSON.parse(after.frontmatter_json) as { sheet?: { alignment?: string } };
    expect(fm.sheet?.alignment).toBe('chaotic neutral');

    expect(after.yjs_state).not.toBeNull();
    expect(before.yjs_state).not.toBeNull();
    expect(Buffer.from(after.yjs_state!)).toEqual(Buffer.from(before.yjs_state!));
  });
});

// ── C3: gm_only must be enforced by the tool layer, not just entity_search ─
//
// `ctx.role` collapses BOTH session roles 'admin' and 'editor' into
// 'dm' — that fold is deliberate and load-bearing for every OTHER
// permission check in this file, so it must stay. But `gm_only` is a
// stricter, separate gate: only session role 'admin' may see gm_only
// content (mirrors collab/server.ts#isNoteGmOnly and
// lib/notes.ts#visibilityFor). Before this fix, note_read (and every
// other path-based tool) only ever looked at the collapsed `role`, so
// an editor — indistinguishable from an admin once collapsed — could
// read or edit a note the UI itself would 404 them out of.
//
// ctxFor('dm', 'editor') is the exact shape of that scenario: the
// collapsed role says "GM tools allowed" while the real session role
// says "not the world owner."

describe('note_read — gm_only enforcement (C3)', () => {
  const path = 'Test/GmOnlySecret.md';

  beforeEach(() => {
    seedNote({
      path,
      title: 'GmOnlySecret',
      pmDoc: { type: 'doc', content: [paragraph('Only the GM should see this.')] },
      contentMd: 'Only the GM should see this.',
      gmOnly: true,
    });
  });

  it('hides a gm_only note from an editor (collapsed role dm, sessionRole editor)', async () => {
    const tools = createTools(ctxFor('dm', 'editor'));
    const result = await tools.note_read.execute!(
      { path },
      { toolCallId: 'gm1', messages: [] },
    );
    const r = result as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    // Must be the SAME shape as a genuinely missing note — not a
    // distinct "access denied" that would confirm the note exists.
    expect(r.error).toBe(`Not found: ${path}`);
  });

  it('lets an admin (sessionRole admin) read the same gm_only note', async () => {
    const tools = createTools(ctxFor('dm', 'admin'));
    const result = await tools.note_read.execute!(
      { path },
      { toolCallId: 'gm2', messages: [] },
    );
    const r = result as { ok: boolean; content?: string };
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Only the GM should see this');
  });
});

describe('entity_edit_content — gm_only enforcement (C3)', () => {
  const path = 'Test/GmOnlyEditable.md';

  beforeEach(() => {
    seedNote({
      path,
      title: 'GmOnlyEditable',
      pmDoc: { type: 'doc', content: [paragraph('GM-only body.')] },
      contentMd: 'GM-only body.',
      gmOnly: true,
    });
  });

  it('refuses to append content to a gm_only note for an editor', async () => {
    const tools = createTools(ctxFor('dm', 'editor'));
    const result = await tools.entity_edit_content.execute!(
      { path, content: 'Leaked via chat.' },
      { toolCallId: 'gm3', messages: [] },
    );
    const r = result as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`Not found: ${path}`);

    // Nothing must have been written.
    const row = readNote(path);
    expect(row.content_md).toBe('GM-only body.');
    expect(row.content_md).not.toContain('Leaked via chat');
  });

  it('lets an admin append content to the same gm_only note', async () => {
    const tools = createTools(ctxFor('dm', 'admin'));
    const result = await tools.entity_edit_content.execute!(
      { path, content: 'Added by the GM.' },
      { toolCallId: 'gm4', messages: [] },
    );
    expect((result as { ok: boolean }).ok).toBe(true);
    const row = readNote(path);
    expect(row.content_md).toContain('Added by the GM');
  });
});

// ── Inline role guards on entity_move / entity_change_kind ────────────
//
// Both tools were previously GM-only ONLY by omission from
// getToolsForRole's player/viewer maps — there was no check inside
// execute(). api/sessions/end/route.ts already hand-picks tools from
// createTools() directly rather than calling getToolsForRole(), so any
// future caller that does the same (or a bug that mis-wires the
// filter) would hand a 'player' context these GM tools with zero
// enforcement. These tests call createTools(ctxFor('player')) directly
// — bypassing getToolsForRole entirely — to prove the guard lives
// inside execute(), matching the sibling pattern in note_write_section
// / session_finalize.

describe('entity_move — inline GM-only guard', () => {
  it('rejects a non-dm caller even when handed the tool directly (bypassing getToolsForRole)', async () => {
    const path = 'Test/MoveMe.md';
    seedNote({
      path,
      title: 'MoveMe',
      pmDoc: { type: 'doc', content: [paragraph('Movable body.')] },
      contentMd: 'Movable body.',
    });

    const tools = createTools(ctxFor('player'));
    const result = await tools.entity_move.execute!(
      { from: path, to: 'Test/Moved.md' },
      { toolCallId: 'mv1', messages: [] },
    );
    const r = result as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('GM only');

    // Nothing must have actually moved.
    const db = getDb();
    const still = db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM notes WHERE group_id=? AND path=?',
      )
      .get(groupId, path);
    expect(still?.n).toBe(1);
  });

  it('allows a dm caller to move the note', async () => {
    const path = 'Test/MoveMeToo.md';
    seedNote({
      path,
      title: 'MoveMeToo',
      pmDoc: { type: 'doc', content: [paragraph('Movable body.')] },
      contentMd: 'Movable body.',
    });

    const tools = createTools(ctxFor('dm'));
    const result = await tools.entity_move.execute!(
      { from: path, to: 'Test/MovedToo.md' },
      { toolCallId: 'mv2', messages: [] },
    );
    expect((result as { ok: boolean; path?: string }).ok).toBe(true);
    expect((result as { path?: string }).path).toBe('Test/MovedToo.md');
  });
});

describe('entity_change_kind — inline GM-only guard', () => {
  it('rejects a non-dm caller even when handed the tool directly (bypassing getToolsForRole)', async () => {
    const path = 'Test/ChangeMe.md';
    seedNote({
      path,
      title: 'ChangeMe',
      pmDoc: { type: 'doc', content: [paragraph('Some body.')] },
      contentMd: 'Some body.',
      frontmatterJson: JSON.stringify({ kind: 'person', template: 'person', sheet: { name: 'ChangeMe' } }),
    });

    const tools = createTools(ctxFor('player'));
    const result = await tools.entity_change_kind.execute!(
      { path, newKind: 'creature', campaignSlug: undefined },
      { toolCallId: 'ck1', messages: [] },
    );
    const r = result as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('GM only');

    // Frontmatter must be untouched.
    const row = readNote(path);
    const fm = JSON.parse(row.frontmatter_json) as { kind?: string };
    expect(fm.kind).toBe('person');
  });
});

describe('inventory_add — does not touch yjs_state', () => {
  it('appends to sheet.items but leaves yjs_state byte-identical', async () => {
    const path = 'Test/Frank.md';
    seedNote({
      path,
      title: 'Frank',
      pmDoc: { type: 'doc', content: [paragraph('Frank is a blacksmith.')] },
      contentMd: 'Frank is a blacksmith.',
      frontmatterJson: '{}',
    });
    const before = readNote(path);

    const tools = createTools(ctxFor('dm'));
    const result = await tools.inventory_add.execute!(
      { characterPath: path, itemPath: undefined, freeformName: 'Torch', quantity: 1 },
      { toolCallId: 't5', messages: [] },
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    const after = readNote(path);
    const fm = JSON.parse(after.frontmatter_json) as { sheet?: { items?: string[] } };
    expect(fm.sheet?.items).toContain('Torch');

    expect(after.yjs_state).not.toBeNull();
    expect(before.yjs_state).not.toBeNull();
    expect(Buffer.from(after.yjs_state!)).toEqual(Buffer.from(before.yjs_state!));
  });
});
