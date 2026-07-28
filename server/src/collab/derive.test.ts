// H7 — the store path must commit `yjs_state` and the derived caches
// (title / content_* / links / tags / FTS) as ONE transaction.
//
// D1 — the CPU-heavy derivation (`computeDerived`) and the DB half must
// share ONE error boundary. A throw escaping `storeNoteDocument` would
// propagate into Hocuspocus's `storeDocumentHooks`, which rethrows,
// which starves `useDebounce`'s cleanup (the execution never clears
// from `runningExecutions`), which pins `shouldUnloadDocument()` false
// forever for that doc — and since `run()` is invoked from a bare
// `setTimeout` with nobody awaiting the promise, the unhandled
// rejection can take the whole process down.
//
// The tests below call `storeNoteDocument` — the exact function
// Hocuspocus's `store()` hook calls — directly, with no WebSocket in
// the loop. Previously this suite drove a test-local `atomicStore`
// helper that re-implemented the transaction shape; that meant a
// regression in `collab/server.ts` (e.g. reintroducing the CPU work
// outside the try, or splitting the transaction again) could sail
// through with this test still green. Calling the real function closes
// that gap.
//
// The load-bearing assertion is "rolls back yjs_state too": before H7,
// yjs_state landed immediately and derive ran later in its own
// transaction, so a crash in between left FTS unable to find text the
// user could already see synced.
//
// D1 needs its own test, and one that discriminates. The foreign-key
// test below proves the try/catch swallows a *DB* failure raised inside
// the transaction — but moving `computeDerived` back outside the try
// would leave it green, because its throw originates further down. The
// "throw from computeDerived itself" test covers the actual D1 shape:
// a synchronous failure in the CPU half, before any DB work begins.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { Document } from '@hocuspocus/server';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import type { PmNode } from '@/lib/md-to-pm';
import { computeDerived } from './derive';
import {
  closeDocumentConnections,
  closeDocumentForWrite,
  collabServer,
  releaseServerWrite,
  storeNoteDocument,
} from './server';

const GROUP = 'grp-derive-test';
const PATH = 'Characters/Arin.md';

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a Y.Doc the same way the editor does: PM JSON into the
 *  'default' XmlFragment plus a Y.Text('title'). */
function makeYDoc(doc: PmNode, title?: string): Y.Doc {
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), doc as object, 'default');
  if (title) ydoc.getText('title').insert(0, title);
  return ydoc;
}

function para(text: string): PmNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function seedGroup(): void {
  getDb()
    .query(`INSERT OR IGNORE INTO groups (id, name, created_at) VALUES (?, ?, ?)`)
    .run(GROUP, 'Derive Test World', Date.now());
}

/** Insert a note with known yjs_state + derived caches. The notes_ai
 *  trigger populates notes_fts from content_text on insert. */
function seedNote(opts: {
  path?: string;
  title?: string;
  contentText?: string;
  contentMd?: string;
  yjsState?: Uint8Array;
  frontmatter?: string;
}): { id: string; yjsState: Uint8Array } {
  const id = randomUUID();
  const yjsState = opts.yjsState ?? new Uint8Array([1, 2, 3, 4]);
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      GROUP,
      opts.path ?? PATH,
      opts.title ?? 'Original Title',
      opts.contentText ?? 'original body text',
      opts.contentMd ?? 'original body text',
      yjsState,
      opts.frontmatter ?? '{}',
      Date.now(),
    );
  return { id, yjsState };
}

function readNote(path = PATH): {
  title: string;
  content_md: string;
  content_text: string;
  yjs_state: Uint8Array | null;
  dm_only: number;
} {
  const row = getDb()
    .query<
      {
        title: string;
        content_md: string;
        content_text: string;
        yjs_state: Uint8Array | null;
        dm_only: number;
      },
      [string, string]
    >(
      `SELECT title, content_md, content_text, yjs_state, dm_only
         FROM notes WHERE group_id = ? AND path = ?`,
    )
    .get(GROUP, path);
  if (!row) throw new Error(`note ${path} missing`);
  return row;
}

/** The FTS row is written by triggers, so reading it proves whether the
 *  trigger side-effects were inside the rolled-back transaction. */
function readFtsContent(path = PATH): string | null {
  const row = getDb()
    .query<{ content: string }, [string, string]>(
      'SELECT content FROM notes_fts WHERE group_id = ? AND path = ?',
    )
    .get(GROUP, path);
  return row?.content ?? null;
}

function ftsMatch(term: string): string[] {
  return getDb()
    .query<{ path: string }, [string, string]>(
      'SELECT path FROM notes_fts WHERE group_id = ? AND notes_fts MATCH ?',
    )
    .all(GROUP, term)
    .map((r) => r.path);
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeAll(() => {
  setupTestDb();
  seedGroup();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  const db = getDb();
  db.query('DELETE FROM notes WHERE group_id = ?').run(GROUP);
  db.query('DELETE FROM note_links WHERE group_id = ?').run(GROUP);
  db.query('DELETE FROM tags WHERE group_id = ?').run(GROUP);
});

describe('computeDerived', () => {
  it('should derive title, markdown, wikilinks and tags without touching the DB', () => {
    // Arrange — a path with NO notes row at all. If computeDerived read
    // or wrote the DB this would either throw or leave a row behind.
    const doc: PmNode = {
      type: 'doc',
      content: [
        para('Arin is from '),
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { target: 'Locations/Havenreach.md', label: '' } },
            { type: 'text', text: ' and is ' },
            { type: 'tagMention', attrs: { tag: 'rogue' } },
          ],
        },
      ],
    };
    const ydoc = makeYDoc(doc, 'Arin Vale');

    // Act
    const derived = computeDerived({ path: 'Nowhere/Ghost.md', doc: ydoc });

    // Assert
    expect(derived.title).toBe('Arin Vale');
    expect(derived.contentText).toContain('Arin is from');
    expect(derived.contentMd).toContain('Arin is from');
    expect(derived.wikilinks).toEqual(['Locations/Havenreach.md']);
    expect(derived.inlineTags).toEqual(['rogue']);

    const rows = getDb()
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM notes WHERE group_id = ?')
      .all(GROUP);
    expect(rows[0]!.n).toBe(0);
  });

  it('should fall back to the first H1 then the filename when Y.Text title is empty', () => {
    // Arrange
    const withH1: PmNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'From H1' }] },
      ],
    };
    const withoutH1: PmNode = { type: 'doc', content: [para('no heading here')] };

    // Act
    const h1 = computeDerived({ path: 'a/b.md', doc: makeYDoc(withH1) });
    const fname = computeDerived({ path: 'Lore/Ancient Pact.md', doc: makeYDoc(withoutH1) });

    // Assert
    expect(h1.title).toBe('From H1');
    expect(fname.title).toBe('Ancient Pact');
  });
});

describe('storeNoteDocument — atomicity of the yjs_state + derive transaction (H7 / D1)', () => {
  it('should swallow an internal failure without throwing, and leave every write rolled back', () => {
    // Arrange
    const { yjsState: originalState } = seedNote({
      title: 'Original Title',
      contentText: 'aardvark original',
      contentMd: 'aardvark original',
    });
    expect(readFtsContent()).toBe('aardvark original');

    const nextState = new Uint8Array([9, 9, 9, 9, 9]);
    const ydoc = makeYDoc({ type: 'doc', content: [para('zebra replacement')] }, 'New Title');

    // Act — a nonexistent userId trips the real `notes.updated_by
    // REFERENCES users(id)` foreign key mid-transaction, forcing a
    // genuine SQLite rollback through the production function (no
    // mocking, no reimplemented transaction shape). D1: the failure
    // must be swallowed here, never rethrown to the caller.
    let threw = false;
    try {
      storeNoteDocument({
        documentName: PATH,
        state: nextState,
        document: ydoc,
        context: { groupId: GROUP, userId: 'nonexistent-user-id' },
      });
    } catch {
      threw = true;
    }

    // Assert
    expect(threw).toBe(false);
    const row = readNote();
    expect(Array.from(row.yjs_state ?? [])).toEqual(Array.from(originalState));
    expect(row.content_md).toBe('aardvark original');
    expect(row.title).toBe('Original Title');
    expect(readFtsContent()).toBe('aardvark original');
    expect(ftsMatch('zebra')).toEqual([]);
    expect(ftsMatch('aardvark')).toEqual([PATH]);
  });

  it('should swallow a throw from computeDerived itself, before any DB work starts', () => {
    // Arrange — a Y.Doc whose 'default' key is a Y.Map instead of the
    // XmlFragment the editor writes. `computeDerived` opens with
    // `yDocToProsemirrorJSON(doc, 'default')`, which calls
    // `doc.getXmlFragment('default')`, and Yjs refuses to re-interpret an
    // already-typed key: "Type with the name default has already been
    // defined with a different constructor". That is a synchronous throw
    // from the CPU half, BEFORE `db.transaction()` is ever reached — so
    // unlike the foreign-key test above, no SQLite rollback is involved
    // and only the try/catch placement can contain it.
    //
    // Not a hypothetical shape: a note row whose `yjs_state` was written
    // by a differently-shaped document (the Excalidraw canvas docs keep
    // their state under Y.Array/Y.Map keys) decodes into exactly this.
    //
    // DISCRIMINATION: moving `computeDerived` back outside the try in
    // `storeNoteDocument` makes this test — and only this test — fail
    // with the Yjs error above. The FK test stays green either way,
    // because its failure originates inside the transaction.
    const { yjsState: originalState } = seedNote({
      title: 'Original Title',
      contentText: 'aardvark original',
      contentMd: 'aardvark original',
    });
    const hostile = new Y.Doc();
    hostile.getMap('default').set('excalidraw-ish', 1);
    expect(() => computeDerived({ path: PATH, doc: hostile })).toThrow();

    // Act
    let threw = false;
    try {
      storeNoteDocument({
        documentName: PATH,
        state: new Uint8Array([9, 9, 9]),
        document: hostile,
        context: { groupId: GROUP, userId: null },
      });
    } catch {
      threw = true;
    }

    // Assert — swallowed, and the row is byte-for-byte untouched.
    expect(threw).toBe(false);
    const row = readNote();
    expect(Array.from(row.yjs_state ?? [])).toEqual(Array.from(originalState));
    expect(row.title).toBe('Original Title');
    expect(row.content_md).toBe('aardvark original');
    expect(readFtsContent()).toBe('aardvark original');
  });

  it('should commit yjs_state, content caches and the FTS row together on success', () => {
    // Arrange
    seedNote({ contentText: 'aardvark original', contentMd: 'aardvark original' });
    const nextState = new Uint8Array([7, 7, 7]);
    const ydoc = makeYDoc({ type: 'doc', content: [para('zebra replacement')] }, 'New Title');

    // Act
    storeNoteDocument({
      documentName: PATH,
      state: nextState,
      document: ydoc,
      context: { groupId: GROUP, userId: null },
    });

    // Assert
    const row = readNote();
    expect(Array.from(row.yjs_state ?? [])).toEqual([7, 7, 7]);
    expect(row.title).toBe('New Title');
    expect(row.content_md).toContain('zebra replacement');
    expect(ftsMatch('zebra')).toEqual([PATH]);
    expect(ftsMatch('aardvark')).toEqual([]);
  });
});

// ── Server-side write coordination: the token protocol ────────────────
//
// `closeDocumentForWrite(path)` issues a capability token;
// `closeDocumentConnections(path, token)` goes DESTRUCTIVE (cancel the
// pending debounced store, then unload) only when handed a live token
// it issued for that same path. Everything else — including a tokenless
// call from `notes/visibility`, a folder delete, a campaign delete —
// keeps the default flush-on-evict, which is what preserves a live
// editor's last ~1.5s of keystrokes.
//
// This replaced a single `Map<path, expiryMs>` flag, whose three
// failure modes are what the tests below pin down. Each one FAILS if
// the flag is reinstated (verified by temporarily reverting
// `closeDocumentConnections` to consume a per-path mark):
//
//   NEW-1 leak       — a token taken and then abandoned (post-drain
//                      `!note`, a 404/409 re-check, a no-op branch, a
//                      throw) must not turn some later unrelated
//                      eviction destructive.
//   NEW-2 mis-pair   — with one flag per path, whoever evicted first
//                      consumed it. Two operations on one path swapped
//                      halves, and the one that actually wrote fell
//                      through to a flush that clobbered its own write.
//   NEW-3 TTL        — expiry was the flag's only leak guard, so it had
//                      to be short (30s) — shorter than import-apply's
//                      own window, which contains an LLM merge call.
//
// OBSERVABLE. With no real WebSocket in the loop, "destructive vs
// flush" is read off Hocuspocus's own debouncer: a pending
// `onStoreDocument-<path>` timer is exactly what an eviction would
// flush, and `discardDocumentAfterWrite` cancels it. `isDebounced` is
// therefore a faithful proxy for "would this eviction write the
// in-memory doc back over the caller's row?".

const STORE_DEBOUNCE_ID = (path: string): string => `onStoreDocument-${path}`;

type EvictionProbe = {
  /** True while Hocuspocus still holds a pending debounced store — i.e.
   *  an eviction right now would FLUSH the in-memory doc to the DB. */
  storeStillPending: () => boolean;
  cleanup: () => void;
};

/** Put a document into the live `documents` map with a pending store
 *  against it, mimicking a client who typed and then went quiet.
 *
 *  The interval stands in for Hocuspocus's own `unloadDocument`: the
 *  real server drops a document from `documents` once its last
 *  connection closes with no store pending. Mirroring that here lets
 *  `discardDocumentAfterWrite` quiesce on its next poll instead of
 *  spinning out the full `DRAIN_BUDGET_MS`, and — because it only fires
 *  AFTER the cancellation it is watching for — it cannot mask the
 *  behaviour under test. */
function armLiveDocumentWithPendingStore(path: string): EvictionProbe {
  const id = STORE_DEBOUNCE_ID(path);
  collabServer.documents.set(path, new Document(path));

  // 5s/10s so the timer can never actually fire mid-test; the
  // assertions read `isDebounced`, never the callback.
  void collabServer.debouncer.debounce(id, () => undefined, 5_000, 10_000);

  const watcher = setInterval(() => {
    if (!collabServer.debouncer.isDebounced(id)) {
      collabServer.documents.delete(path);
      clearInterval(watcher);
    }
  }, 1);

  return {
    storeStillPending: () => collabServer.debouncer.isDebounced(id),
    cleanup: () => {
      clearInterval(watcher);
      collabServer.documents.delete(path);
      void collabServer.debouncer.debounce(id, () => undefined, 0, 0);
    },
  };
}

describe('closeDocumentConnections — server-write token protocol', () => {
  const PROTO_PATH = 'Characters/Contested.md';

  it('should discard the in-memory document when handed its own token', async () => {
    // Arrange
    const token = await closeDocumentForWrite(PROTO_PATH);
    const probe = armLiveDocumentWithPendingStore(PROTO_PATH);

    try {
      // Act
      await closeDocumentConnections(PROTO_PATH, token);

      // Assert — the pre-write state must NOT be written back over the
      // row the caller just updated.
      expect(probe.storeStillPending()).toBe(false);
    } finally {
      probe.cleanup();
    }
  });

  it('should flush rather than discard when no token is presented', async () => {
    // Arrange — the `notes/visibility` / folder-delete / campaign-delete
    // shape: evicting so clients re-authenticate, NOT replacing a body.
    const probe = armLiveDocumentWithPendingStore(PROTO_PATH);

    try {
      // Act
      await closeDocumentConnections(PROTO_PATH);

      // Assert — the live editor's keystrokes still reach disk.
      expect(probe.storeStillPending()).toBe(true);
    } finally {
      probe.cleanup();
    }
  });

  it('should not let a stranded token make a later unrelated eviction destructive (NEW-1)', async () => {
    // Arrange — an operation takes a token and then early-returns
    // without consuming OR releasing it: the literal leak.
    await closeDocumentForWrite(PROTO_PATH);
    const probe = armLiveDocumentWithPendingStore(PROTO_PATH);

    try {
      // Act — a completely different caller evicts the same path with
      // no token of its own.
      await closeDocumentConnections(PROTO_PATH);

      // Assert — it must still get flush semantics. Under the per-path
      // flag this consumed the leaked mark and silently dropped up to
      // 1.5s of a live editor's typing.
      expect(probe.storeStillPending()).toBe(true);
    } finally {
      probe.cleanup();
    }
  });

  it('should refuse a token that was already released', async () => {
    // Arrange
    const token = await closeDocumentForWrite(PROTO_PATH);
    releaseServerWrite(token);
    const probe = armLiveDocumentWithPendingStore(PROTO_PATH);

    try {
      // Act — presenting a revoked token back.
      await closeDocumentConnections(PROTO_PATH, token);

      // Assert — release really revokes; this is what makes the
      // unconditional `finally { releaseServerWrite(token) }` at the
      // call sites safe rather than merely tidy.
      expect(probe.storeStillPending()).toBe(true);
    } finally {
      probe.cleanup();
    }
  });

  it('should refuse a token that was already consumed', async () => {
    // Arrange
    const token = await closeDocumentForWrite(PROTO_PATH);
    const first = armLiveDocumentWithPendingStore(PROTO_PATH);
    try {
      await closeDocumentConnections(PROTO_PATH, token);
    } finally {
      first.cleanup();
    }

    const second = armLiveDocumentWithPendingStore(PROTO_PATH);
    try {
      // Act — the same token a second time.
      await closeDocumentConnections(PROTO_PATH, token);

      // Assert — one token, one destructive evict.
      expect(second.storeStillPending()).toBe(true);
    } finally {
      second.cleanup();
    }
  });

  it('should refuse a token issued for a different path', async () => {
    // Arrange
    const token = await closeDocumentForWrite('Characters/Elsewhere.md');
    const probe = armLiveDocumentWithPendingStore(PROTO_PATH);

    try {
      // Act
      await closeDocumentConnections(PROTO_PATH, token);

      // Assert
      expect(probe.storeStillPending()).toBe(true);
    } finally {
      probe.cleanup();
      releaseServerWrite(token);
    }
  });

  it('should not let an unrelated eviction consume an in-flight operation\'s token (NEW-2)', async () => {
    // Arrange — op A (entity_edit_content) takes its token and starts
    // computing the new document.
    const tokenA = await closeDocumentForWrite(PROTO_PATH);

    // Act 1 — op B (notes/visibility on the same path) evicts, tokenless.
    const probeB = armLiveDocumentWithPendingStore(PROTO_PATH);
    let bDiscarded: boolean;
    try {
      await closeDocumentConnections(PROTO_PATH);
      bDiscarded = !probeB.storeStillPending();
    } finally {
      probeB.cleanup();
    }

    // Act 2 — op A finishes its UPDATE and evicts with ITS token.
    const probeA = armLiveDocumentWithPendingStore(PROTO_PATH);
    let aDiscarded: boolean;
    try {
      await closeDocumentConnections(PROTO_PATH, tokenA);
      aDiscarded = !probeA.storeStillPending();
    } finally {
      probeA.cleanup();
    }

    // Assert — B must have flushed (it replaced no body) and A must
    // have discarded (it did). The per-path flag inverted BOTH: B
    // consumed A's arming and went destructive, then A found nothing
    // armed, flushed the PRE-write document, and clobbered its own row.
    expect(bDiscarded).toBe(false);
    expect(aDiscarded).toBe(true);
  });

  it('should give each of two concurrent operations on one path its own token', async () => {
    // Arrange — two body-replacing operations overlap on one path.
    const tokenA = await closeDocumentForWrite(PROTO_PATH);
    const tokenB = await closeDocumentForWrite(PROTO_PATH);

    // Act 1 — B finishes first and consumes its own token.
    const probeB = armLiveDocumentWithPendingStore(PROTO_PATH);
    let bDiscarded: boolean;
    try {
      await closeDocumentConnections(PROTO_PATH, tokenB);
      bDiscarded = !probeB.storeStillPending();
    } finally {
      probeB.cleanup();
    }

    // Act 2 — A's token must be untouched by that.
    const probeA = armLiveDocumentWithPendingStore(PROTO_PATH);
    let aDiscarded: boolean;
    try {
      await closeDocumentConnections(PROTO_PATH, tokenA);
      aDiscarded = !probeA.storeStillPending();
    } finally {
      probeA.cleanup();
    }

    // Assert — tokens are counted, not a single shared flag. With one
    // flag per path, B's consume disarmed A and this second evict
    // flushed A's stale document over A's write.
    expect(bDiscarded).toBe(true);
    expect(aDiscarded).toBe(true);
  });

  it('should still honour a token after a window longer than the old 30s TTL (NEW-3)', async () => {
    // Arrange — import-apply arms, then awaits `runMerge()`, an LLM
    // call that routinely runs longer than the old expiry.
    const token = await closeDocumentForWrite(PROTO_PATH);

    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      const probe = armLiveDocumentWithPendingStore(PROTO_PATH);
      try {
        // Act
        await closeDocumentConnections(PROTO_PATH, token);

        // Assert — pairing is explicit now, so nothing about the
        // elapsed time can downgrade this to a flush. The 30s TTL
        // silently re-exposed exactly this write to the stale-flush
        // clobber it was there to prevent.
        expect(probe.storeStillPending()).toBe(false);
      } finally {
        probe.cleanup();
      }
    } finally {
      Date.now = realNow;
    }
  });
});

describe('storeNoteDocument — derived rows written by persistDerived', () => {
  it('should replace body-derived links but preserve manual and index links', () => {
    // Arrange
    seedNote({});
    const db = getDb();
    db.query(
      `INSERT INTO note_links (group_id, from_path, to_path, is_manual, is_index)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(GROUP, PATH, 'Manual/Kept.md', 1, 0);
    db.query(
      `INSERT INTO note_links (group_id, from_path, to_path, is_manual, is_index)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(GROUP, PATH, 'Characters/index.md', 0, 1);
    db.query(
      `INSERT INTO note_links (group_id, from_path, to_path, is_manual, is_index)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(GROUP, PATH, 'Stale/Body.md', 0, 0);

    const ydoc = makeYDoc(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'wikilink', attrs: { target: 'Fresh/Body.md', label: '' } }],
          },
        ],
      },
      'T',
    );

    // Act
    storeNoteDocument({
      documentName: PATH,
      state: new Uint8Array([1]),
      document: ydoc,
      context: { groupId: GROUP, userId: null },
    });

    // Assert
    const targets = db
      .query<{ to_path: string }, [string, string]>(
        'SELECT to_path FROM note_links WHERE group_id = ? AND from_path = ? ORDER BY to_path',
      )
      .all(GROUP, PATH)
      .map((r) => r.to_path);
    expect(targets).toEqual(['Characters/index.md', 'Fresh/Body.md', 'Manual/Kept.md']);
  });

  it('should union inline tags with frontmatter tags and mirror dm_only', () => {
    // Arrange
    seedNote({ frontmatter: JSON.stringify({ tags: ['#Lore'], dmOnly: true }) });
    const ydoc = makeYDoc(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'tagMention', attrs: { tag: 'rogue' } }] },
        ],
      },
      'T',
    );

    // Act
    storeNoteDocument({
      documentName: PATH,
      state: new Uint8Array([1]),
      document: ydoc,
      context: { groupId: GROUP, userId: null },
    });

    // Assert
    const tags = getDb()
      .query<{ tag: string }, [string, string]>(
        'SELECT tag FROM tags WHERE group_id = ? AND path = ? ORDER BY tag',
      )
      .all(GROUP, PATH)
      .map((r) => r.tag);
    expect(tags).toEqual(['lore', 'rogue']);
    expect(readNote().dm_only).toBe(1);
  });
});
