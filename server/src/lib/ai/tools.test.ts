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
import { computeDerived, persistDerived } from '@/collab/derive';
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
  // post-write `closeDocumentConnections(groupId, path, token)`, and a
  // spy that swallowed it would silently downgrade every one of these
  // tests to the tokenless flush path.
  const drainSpy = async (gid: string, p: string): Promise<ServerWriteToken> => {
    if (p === path) applyFlush();
    return realClose(gid, p);
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
    expect(row.content_md).toContain('[[Test/CarolConcurrent.md]]');
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

    // The Hocuspocus documents map is keyed by the QUALIFIED document
    // name (`${groupId}:${path}`) — see collab/server.ts. Match that
    // here so the in-memory doc/debounce entries this test plants are
    // actually the ones closeDocumentConnections looks up.
    const documentName = `${groupId}:${path}`;
    const hocuspocus = ORIGINAL_COLLAB_SERVER.collabServer;
    const storeId = `onStoreDocument-${documentName}`;
    hocuspocus.documents.set(documentName, new Document(documentName));
    void hocuspocus.debouncer.debounce(storeId, () => undefined, 5_000, 10_000);

    try {
      const tools = createTools(ctxFor('player'));
      // Act 1 — the concurrent flush lands the link first, so the tool
      // takes its post-drain no-op return.
      const result = await withSimulatedConcurrentFlush(
        path,
        () => {
          getDb()
            .query('UPDATE notes SET content_md=?, content_json=? WHERE group_id=? AND path=?')
            .run(
              'Bob is a travelling merchant.\n\n[[Carol]]',
              JSON.stringify({
                type: 'doc',
                content: [
                  paragraph('Bob is a travelling merchant.'),
                  { type: 'paragraph', content: [{ type: 'wikilink', attrs: { target: 'Test/Carol.md', label: 'Carol' } }] },
                ],
              }),
              groupId,
              path,
            );
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
      await ORIGINAL_COLLAB_SERVER.closeDocumentConnections(groupId, path);

      // Assert — flush semantics preserved. If the tool had stranded
      // its token, this eviction would have consumed it and cancelled
      // the live editor's pending store instead.
      expect(hocuspocus.debouncer.isDebounced(storeId)).toBe(true);
    } finally {
      hocuspocus.documents.delete(documentName);
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
    const calls: Array<{ groupId: string; path: string; hadToken: boolean }> = [];
    const evictSpy = async (
      gid: string,
      p: string,
      token?: ServerWriteToken,
    ): Promise<void> => {
      calls.push({ groupId: gid, path: p, hadToken: token !== undefined });
      return realEvict(gid, p, token);
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
      expect(calls).toEqual([{ groupId, path, hadToken: true }]);
    } finally {
      // Restore from the frozen snapshot — see ORIGINAL_COLLAB_SERVER.
      mock.module('@/collab/server', () => ORIGINAL_COLLAB_SERVER);
    }
  });
});

describe('note_write_section — its post-write evict is actually destructive', () => {
  it('cancels the live editor\'s pending store rather than flushing it', async () => {
    // note_write_section writes through applyNoteEdit, which takes the
    // token, writes, and evicts. Dropping the token on the way —
    // `closeDocumentConnections(groupId, path)` instead of
    // `closeDocumentConnections(groupId, path, token)` — leaves every
    // other test in this file green while silently restoring the
    // flush-on-evict that lets a live editor's pre-write document land
    // back on top of the section write. Verified: that one-word change
    // fails this test and nothing else.
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

    // Document map is keyed by the QUALIFIED name — see the comment in
    // the NEW-1 backlink_create test above.
    const documentName = `${groupId}:${path}`;
    const hocuspocus = ORIGINAL_COLLAB_SERVER.collabServer;
    const storeId = `onStoreDocument-${documentName}`;
    hocuspocus.documents.set(documentName, new Document(documentName));
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
      hocuspocus.documents.delete(documentName);
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
// execute(). Any caller that hand-picks tools from createTools()
// directly rather than calling getToolsForRole() (or a bug that
// mis-wires the filter) would hand a 'player' context these GM tools with zero
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

describe('entity_create — canonical kinds', () => {
  function seedCampaign(): void {
    const db = getDb();
    db.query('DELETE FROM campaigns WHERE group_id = ?').run(groupId);
    db.query(
      `INSERT INTO campaigns (group_id, slug, name, folder_path, created_at)
       VALUES (?, 'mill', 'The Mill', 'Campaigns/mill', ?)`,
    ).run(groupId, Date.now());
  }

  it('creates a quest under Quests/ with kind quest', async () => {
    seedCampaign();
    const tools = createTools(ctxFor('dm'));

    const result = await tools.entity_create.execute!(
      { kind: 'quest', name: 'Find the Miller', campaignSlug: 'mill', dmOnly: false },
      { toolCallId: 'ec1', messages: [] },
    );

    expect(result).toMatchObject({ ok: true, path: 'Campaigns/mill/Quests/find-the-miller.md' });
    const fm = JSON.parse(readNote('Campaigns/mill/Quests/find-the-miller.md').frontmatter_json);
    expect(fm).toEqual({ kind: 'quest' });
  });

  it('creates a villain as a person under People/', async () => {
    seedCampaign();
    const tools = createTools(ctxFor('dm'));

    const result = await tools.entity_create.execute!(
      { kind: 'villain', name: 'Grell', campaignSlug: 'mill', dmOnly: false },
      { toolCallId: 'ec2', messages: [] },
    );

    expect(result).toMatchObject({ ok: true, path: 'Campaigns/mill/People/grell.md' });
    const fm = JSON.parse(readNote('Campaigns/mill/People/grell.md').frontmatter_json);
    expect(fm.kind).toBe('person');
  });
});

describe('backlink_create — link target survives the next collab save', () => {
  /** Re-run the same derive the Hocuspocus store hook runs on the next
   *  editor save: decode the stored yjs_state and persist its links. */
  function resaveFromYjs(path: string): void {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, readNote(path).yjs_state!);
    const derived = computeDerived({ path, doc: ydoc });
    const db = getDb();
    db.transaction(() => persistDerived({ groupId, path, userId, derived }))();
  }

  function linksFrom(path: string): string[] {
    return getDb()
      .query<{ to_path: string }, [string, string]>(
        'SELECT to_path FROM note_links WHERE group_id = ? AND from_path = ? ORDER BY to_path',
      )
      .all(groupId, path)
      .map((r) => r.to_path);
  }

  it('should keep the edge pointing at the full target path after a re-derive', async () => {
    const fromPath = 'Campaigns/Demo/Sessions/One.md';
    const toPath = 'Campaigns/Demo/People/Aldric.md';
    seedNote({ path: fromPath, title: 'One', pmDoc: { type: 'doc', content: [paragraph('Session one.')] }, contentMd: 'Session one.' });

    const tools = createTools(ctxFor('dm'));
    await tools.backlink_create.execute!({ fromPath, toPath, label: undefined }, { toolCallId: 'bl1', messages: [] });
    resaveFromYjs(fromPath);

    expect(linksFrom(fromPath)).toEqual([toPath]);
  });

  it('should add the link when the note only links to a target sharing a name prefix', async () => {
    const fromPath = 'Campaigns/Demo/Sessions/Two.md';
    const longer = 'Campaigns/Demo/People/Aldricson.md';
    const toPath = 'Campaigns/Demo/People/Aldric.md';
    seedNote({
      path: fromPath,
      title: 'Two',
      pmDoc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'wikilink', attrs: { target: longer, label: 'Aldricson', orphan: false } }] }],
      },
      contentMd: '[[Aldricson]]',
    });

    const tools = createTools(ctxFor('dm'));
    await tools.backlink_create.execute!({ fromPath, toPath, label: undefined }, { toolCallId: 'bl2', messages: [] });
    resaveFromYjs(fromPath);

    expect(linksFrom(fromPath)).toEqual([toPath, longer].sort());
  });
});

describe('note_read — dm_only enforcement', () => {
  it('should answer for a dm_only note exactly as for a missing one when the caller is a viewer', async () => {
    const path = 'Test/DmOnlySecret.md';
    seedNote({ path, title: 'DmOnlySecret', pmDoc: { type: 'doc', content: [paragraph('GM eyes.')] }, contentMd: 'GM eyes.' });
    getDb().query('UPDATE notes SET dm_only = 1 WHERE group_id = ? AND path = ?').run(groupId, path);
    const tools = createTools(ctxFor('viewer'));

    const hidden = await tools.note_read.execute!({ path }, { toolCallId: 'dm1', messages: [] });
    const missing = await tools.note_read.execute!({ path: 'Test/Nope.md' }, { toolCallId: 'dm2', messages: [] });

    expect(hidden).toEqual({ ok: false, error: `Not found: ${path}` });
    expect(missing).toEqual({ ok: false, error: 'Not found: Test/Nope.md' });
  });
});

// ── C3 follow-ups: the remaining tools an editor could use on gm_only ──
//
// ctxFor('dm', 'editor') is the GM-tools-allowed, not-the-world-owner
// caller from the C3 block above.

function noteExists(path: string): boolean {
  return getDb()
    .query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM notes WHERE group_id=? AND path=?')
    .get(groupId, path)!.n > 0;
}

function sessionStatus(path: string): string | null {
  return getDb()
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM session_notes WHERE group_id=? AND note_path=?',
    )
    .get(groupId, path)?.status ?? null;
}

describe('session_finalize — gm_only enforcement', () => {
  const path = 'Adventure Log/gm-prep.md';

  beforeEach(() => {
    seedNote({
      path,
      title: 'GM prep',
      pmDoc: { type: 'doc', content: [paragraph('Secret session.')] },
      contentMd: 'Secret session.',
      frontmatterJson: JSON.stringify({ kind: 'session' }),
      gmOnly: true,
    });
  });

  it('should answer an editor as if the gm_only session did not exist, and leave it open', async () => {
    const tools = createTools(ctxFor('dm', 'editor'));

    const hidden = await tools.session_finalize.execute!({ sessionPath: path }, { toolCallId: 'sf1', messages: [] });
    const missing = await tools.session_finalize.execute!(
      { sessionPath: 'Adventure Log/nope.md' },
      { toolCallId: 'sf2', messages: [] },
    );

    expect(hidden).toEqual({ ok: false, error: `Not found: ${path}` });
    expect(missing).toEqual({ ok: false, error: 'Not found: Adventure Log/nope.md' });
    expect(sessionStatus(path)).not.toBe('closed');
  });

  it('should let an admin close the same gm_only session', async () => {
    const tools = createTools(ctxFor('dm', 'admin'));

    const result = await tools.session_finalize.execute!({ sessionPath: path }, { toolCallId: 'sf3', messages: [] });

    expect(result).toEqual({ ok: true, sessionPath: path });
    expect(sessionStatus(path)).toBe('closed');
  });

  it('should drop a pending Wrap-up proposal when it closes the Session, like every other close', async () => {
    getDb()
      .query(
        `INSERT INTO session_notes (group_id, note_path, updated_at, wrap_up_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (group_id, note_path) DO UPDATE SET wrap_up_json = excluded.wrap_up_json`,
      )
      .run(groupId, path, Date.now(), JSON.stringify({ sessionPath: path, generatedAt: 1, mentions: [] }));
    const tools = createTools(ctxFor('dm', 'admin'));

    await tools.session_finalize.execute!({ sessionPath: path }, { toolCallId: 'sf4', messages: [] });

    const row = getDb()
      .query<{ wrap_up_json: string | null }, [string, string]>(
        'SELECT wrap_up_json FROM session_notes WHERE group_id=? AND note_path=?',
      )
      .get(groupId, path);
    expect(row?.wrap_up_json).toBeNull();
  });

  it('should refuse a note that is not a Session and leave no session row', async () => {
    const plain = 'Adventure Log/not-a-session.md';
    seedNote({ path: plain, title: 'Plain', pmDoc: { type: 'doc', content: [paragraph('Hi.')] }, contentMd: 'Hi.' });
    const tools = createTools(ctxFor('dm', 'admin'));

    const result = await tools.session_finalize.execute!({ sessionPath: plain }, { toolCallId: 'sf5', messages: [] });

    expect(result).toMatchObject({ ok: false });
    expect(sessionStatus(plain)).toBeNull();
  });
});

describe('entity_move — a gm_only destination is not an existence oracle', () => {
  const from = 'Test/Visible.md';
  const hiddenTo = 'Test/GmSecret.md';
  const visibleTo = 'Test/Taken.md';

  beforeEach(() => {
    seedNote({ path: from, title: 'Visible', pmDoc: { type: 'doc', content: [paragraph('Mine.')] }, contentMd: 'Mine.' });
    seedNote({
      path: hiddenTo,
      title: 'GmSecret',
      pmDoc: { type: 'doc', content: [paragraph('Hidden.')] },
      contentMd: 'Hidden.',
      gmOnly: true,
    });
    seedNote({ path: visibleTo, title: 'Taken', pmDoc: { type: 'doc', content: [paragraph('Taken.')] }, contentMd: 'Taken.' });
  });

  it('should answer an editor with the not-found shape a gm_only note gets from note_read', async () => {
    const tools = createTools(ctxFor('dm', 'editor'));

    const move = await tools.entity_move.execute!({ from, to: hiddenTo }, { toolCallId: 'mo1', messages: [] });
    const read = await tools.note_read.execute!({ path: hiddenTo }, { toolCallId: 'mo2', messages: [] });

    expect(move).toEqual(read);
    expect(noteExists(from)).toBe(true);
  });

  it('should still report a collision with a note the editor can see', async () => {
    const tools = createTools(ctxFor('dm', 'editor'));

    const move = await tools.entity_move.execute!({ from, to: visibleTo }, { toolCallId: 'mo3', messages: [] });

    expect(move).toEqual({ ok: false, error: `Path exists: ${visibleTo}` });
  });

  it('should report the collision to an admin, who can see the gm_only note', async () => {
    const tools = createTools(ctxFor('dm', 'admin'));

    const move = await tools.entity_move.execute!({ from, to: hiddenTo }, { toolCallId: 'mo4', messages: [] });

    expect(move).toEqual({ ok: false, error: `Path exists: ${hiddenTo}` });
  });
});

describe('entity_change_kind — a gm_only destination is not an existence oracle', () => {
  it('should answer an editor with the not-found shape when the new canonical path is gm_only', async () => {
    const path = 'People/goblin.md';
    const hiddenTo = 'Creatures/goblin.md';
    seedNote({
      path,
      title: 'Goblin',
      pmDoc: { type: 'doc', content: [paragraph('A goblin.')] },
      contentMd: 'A goblin.',
      frontmatterJson: JSON.stringify({ kind: 'person', template: 'person' }),
    });
    seedNote({
      path: hiddenTo,
      title: 'Goblin',
      pmDoc: { type: 'doc', content: [paragraph('GM goblin.')] },
      contentMd: 'GM goblin.',
      gmOnly: true,
    });
    const tools = createTools(ctxFor('dm', 'editor'));

    const result = await tools.entity_change_kind.execute!(
      { path, newKind: 'creature', campaignSlug: undefined },
      { toolCallId: 'ck2', messages: [] },
    );

    expect(result).toEqual({ ok: false, error: `Not found: ${hiddenTo}` });
    expect(JSON.parse(readNote(path).frontmatter_json).kind).toBe('person');
  });
});

// A rename changes notes.path under an open editor. Its document, still
// loaded under the old name, would store() into a row that no longer
// exists, so the tool must take it out of memory after the write, and
// discard rather than flush it, as every other server write does.

/** Plants a loaded document with a pending store on `path`, runs `fn`,
 *  and reports whether the document and its pending store survived. */
async function withOpenEditor(
  path: string,
  fn: () => unknown,
): Promise<{ result: unknown; stillLoaded: boolean; storePending: boolean }> {
  const documentName = `${groupId}:${path}`;
  const hocuspocus = ORIGINAL_COLLAB_SERVER.collabServer;
  const storeId = `onStoreDocument-${documentName}`;
  hocuspocus.documents.set(documentName, new Document(documentName));
  void hocuspocus.debouncer.debounce(storeId, () => undefined, 5_000, 10_000);
  try {
    const result = await fn();
    return {
      result,
      stillLoaded: hocuspocus.documents.has(documentName),
      storePending: hocuspocus.debouncer.isDebounced(storeId),
    };
  } finally {
    hocuspocus.documents.delete(documentName);
    void hocuspocus.debouncer.debounce(storeId, () => undefined, 0, 0);
  }
}

describe('entity_move — evicts the open editor of the renamed note', () => {
  it('should discard the document left open under the old path', async () => {
    const from = 'Test/OpenWhileMoved.md';
    seedNote({ path: from, title: 'Open', pmDoc: { type: 'doc', content: [paragraph('Open.')] }, contentMd: 'Open.' });
    const tools = createTools(ctxFor('dm'));

    const outcome = await withOpenEditor(from, () =>
      tools.entity_move.execute!({ from, to: 'Test/MovedWhileOpen.md' }, { toolCallId: 'ev1', messages: [] }),
    );

    expect(outcome.result).toEqual({ ok: true, path: 'Test/MovedWhileOpen.md' });
    expect(outcome.stillLoaded).toBe(false);
    expect(outcome.storePending).toBe(false);
  });
});

describe('entity_change_kind — evicts the open editor of the renamed note', () => {
  it('should discard the document left open under the old path', async () => {
    const path = 'People/open-npc.md';
    seedNote({
      path,
      title: 'Open NPC',
      pmDoc: { type: 'doc', content: [paragraph('Open.')] },
      contentMd: 'Open.',
      frontmatterJson: JSON.stringify({ kind: 'person', template: 'person' }),
    });
    const tools = createTools(ctxFor('dm'));

    const outcome = await withOpenEditor(path, () =>
      tools.entity_change_kind.execute!(
        { path, newKind: 'creature', campaignSlug: undefined },
        { toolCallId: 'ev2', messages: [] },
      ),
    );

    expect(outcome.result).toEqual({ ok: true, path: 'Creatures/open-npc.md', kind: 'creature' });
    expect(outcome.stillLoaded).toBe(false);
    expect(outcome.storePending).toBe(false);
  });
});

describe('entity_move — structured-note index rows follow the rename', () => {
  it('should move an item note and carry its items row instead of failing the FK check', async () => {
    const from = 'Loot/sword.md';
    const to = 'Loot/blade.md';
    seedNote({
      path: from,
      title: 'Sword',
      pmDoc: { type: 'doc', content: [paragraph('A sword.')] },
      contentMd: 'A sword.',
      frontmatterJson: JSON.stringify({ kind: 'item' }),
    });
    const db = getDb();
    db.query('INSERT INTO items (group_id, note_path, name, updated_at) VALUES (?, ?, ?, ?)')
      .run(groupId, from, 'Sword', Date.now());
    const tools = createTools(ctxFor('dm'));

    const result = await tools.entity_move.execute!({ from, to }, { toolCallId: 'ix1', messages: [] });

    expect(result).toEqual({ ok: true, path: to });
    const row = db.query<{ note_path: string }, [string]>('SELECT note_path FROM items WHERE group_id=?').get(groupId);
    expect(row?.note_path).toBe(to);
  });
});

describe('entity_move — the destination is re-checked after the editors drain', () => {
  it('should report Path exists when a note appears at the destination during the drain', async () => {
    const from = 'Test/RaceFrom.md';
    const to = 'Test/RaceTo.md';
    seedNote({ path: from, title: 'From', pmDoc: { type: 'doc', content: [paragraph('From.')] }, contentMd: 'From.' });
    const tools = createTools(ctxFor('dm'));

    const result = await withSimulatedConcurrentFlush(
      from,
      () => seedNote({ path: to, title: 'To', pmDoc: { type: 'doc', content: [paragraph('To.')] }, contentMd: 'To.' }),
      () => tools.entity_move.execute!({ from, to }, { toolCallId: 'rc1', messages: [] }),
    );

    expect(result).toEqual({ ok: false, error: `Path exists: ${to}` });
    expect(noteExists(from)).toBe(true);
  });

  it('should report Not found rather than ok when the source is deleted during the drain', async () => {
    const from = 'Test/RaceGone.md';
    const to = 'Test/RaceGoneTo.md';
    seedNote({ path: from, title: 'Gone', pmDoc: { type: 'doc', content: [paragraph('Gone.')] }, contentMd: 'Gone.' });
    const tools = createTools(ctxFor('dm'));

    const result = await withSimulatedConcurrentFlush(
      from,
      () => { getDb().query('DELETE FROM notes WHERE group_id=? AND path=?').run(groupId, from); },
      () => tools.entity_move.execute!({ from, to }, { toolCallId: 'rc2', messages: [] }),
    );

    expect(result).toEqual({ ok: false, error: `Not found: ${from}` });
    expect(noteExists(to)).toBe(false);
  });
});

describe('inventory_add — cannot write the name of an item the caller cannot see', () => {
  const characterPath = 'Characters/hero.md';

  beforeEach(() => {
    seedNote({
      path: characterPath,
      title: 'Hero',
      pmDoc: { type: 'doc', content: [paragraph('A hero.')] },
      contentMd: 'A hero.',
      frontmatterJson: JSON.stringify({ kind: 'character', sheet: { items: [] } }),
    });
  });

  function items(): string[] {
    return (JSON.parse(readNote(characterPath).frontmatter_json) as { sheet: { items: string[] } }).sheet.items;
  }

  it('should answer an editor as if a gm_only item did not exist, and leave the sheet alone', async () => {
    const itemPath = 'Loot/vorpal-blade.md';
    seedNote({ path: itemPath, title: 'Vorpal Blade', pmDoc: { type: 'doc', content: [] }, contentMd: '', gmOnly: true });
    const tools = createTools(ctxFor('dm', 'editor'));

    const hidden = await tools.inventory_add.execute!(
      { characterPath, itemPath, freeformName: undefined, quantity: 1 },
      { toolCallId: 'ia1', messages: [] },
    );
    const missing = await tools.inventory_add.execute!(
      { characterPath, itemPath: 'Loot/nope.md', freeformName: undefined, quantity: 1 },
      { toolCallId: 'ia2', messages: [] },
    );

    expect(hidden).toEqual({ ok: false, error: `Not found: ${itemPath}` });
    expect(missing).toEqual({ ok: false, error: 'Not found: Loot/nope.md' });
    expect(items()).toEqual([]);
  });

  it('should refuse a dm_only item to a player', async () => {
    const itemPath = 'Loot/cursed-ring.md';
    seedNote({ path: itemPath, title: 'Cursed Ring', pmDoc: { type: 'doc', content: [] }, contentMd: '' });
    getDb().query('UPDATE notes SET dm_only = 1 WHERE group_id = ? AND path = ?').run(groupId, itemPath);
    const tools = createTools(ctxFor('player'));

    const result = await tools.inventory_add.execute!(
      { characterPath, itemPath, freeformName: undefined, quantity: 1 },
      { toolCallId: 'ia3', messages: [] },
    );

    expect(result).toEqual({ ok: false, error: `Not found: ${itemPath}` });
    expect(items()).toEqual([]);
  });

  it('should link an item the caller can see', async () => {
    const itemPath = 'Loot/rope.md';
    seedNote({ path: itemPath, title: 'Rope', pmDoc: { type: 'doc', content: [] }, contentMd: '' });
    const tools = createTools(ctxFor('dm', 'editor'));

    const result = await tools.inventory_add.execute!(
      { characterPath, itemPath, freeformName: undefined, quantity: 2 },
      { toolCallId: 'ia4', messages: [] },
    );

    expect(result).toEqual({ ok: true });
    expect(items()).toEqual(['[[rope]] ×2']);
  });
});
