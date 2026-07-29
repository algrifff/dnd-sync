// Hocuspocus WebSocket server — handles live collaborative editing.
// Instantiated with `new Hocuspocus({...})` and mounted into the
// existing http server's upgrade path at /collab; we handle the
// WS handshake ourselves so session-cookie auth can run BEFORE
// hocuspocus loads the document.

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Logger } from '@hocuspocus/extension-logger';
import { getDb } from '@/lib/db';
import { readSessionFromIncoming, type Session } from '@/lib/session';
import { isPcOwnedBy } from '@/lib/characters';
import { computeDerived, persistDerived, deriveIndexesFor } from './derive';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

/** Per-connection bookkeeping so disconnect events can report a duration
 *  without hitting the DB. Entries are dropped in the onDisconnect hook.
 *  Stale entries would only accumulate on server crash — fine for a
 *  long-running process.
 *
 *  Keyed by `${socketId}::${documentName}`, NOT by socketId alone.
 *  Hocuspocus 3 multiplexes any number of documents over one socket
 *  (`ClientConnection` keeps a `documentConnections` map), and both
 *  `onAuthenticate` and `onDisconnect` fire once per document. Today
 *  every provider opens its own socket so socketId happened to be 1:1
 *  with a document — but the moment anything shares a
 *  `HocuspocusProviderWebsocket`, a socketId-only key would have the
 *  second document overwrite the first's entry, and the first
 *  disconnect would then report the wrong document and delete the
 *  survivor's row. */
type ConnectionInfo = {
  userId: string;
  groupId: string;
  /** BARE note path (no group prefix) — for analytics only. */
  path: string;
  connectedAt: number;
  readOnly: boolean;
};
const connectionInfo = new Map<string, ConnectionInfo>();

function connectionKey(socketId: string, documentName: string): string {
  return `${socketId}::${documentName}`;
}

/** Throttle NOTE_EDITED events to once per note per 60s window so a
 *  typist doesn't spam PostHog with one event per debounced save. */
const lastEditCapture = new Map<string, number>();
const NOTE_EDIT_THROTTLE_MS = 60_000;

/** Hard cap on `lastEditCapture`. Without one the map grows by a
 *  permanent entry per `group::path` ever edited and is never swept —
 *  unbounded for the life of the process. */
const LAST_EDIT_CAPTURE_MAX = 5_000;

/** True when a NOTE_EDITED capture is due for `key`, recording the
 *  decision. Keeps `lastEditCapture` bounded as a side effect.
 *
 *  The sweep cannot change behaviour: an entry older than the throttle
 *  window can only ever answer "allowed", which is exactly what a
 *  missing entry answers. The `clear()` fallback (>5000 distinct notes
 *  edited inside one 60s window — not a real workload) can cost at most
 *  one extra event per note, never a lost one. */
function noteEditCaptureDue(key: string, now: number): boolean {
  if (now - (lastEditCapture.get(key) ?? 0) < NOTE_EDIT_THROTTLE_MS) return false;

  if (lastEditCapture.size >= LAST_EDIT_CAPTURE_MAX) {
    for (const [k, ts] of lastEditCapture) {
      if (now - ts >= NOTE_EDIT_THROTTLE_MS) lastEditCapture.delete(k);
    }
    if (lastEditCapture.size >= LAST_EDIT_CAPTURE_MAX) lastEditCapture.clear();
  }

  lastEditCapture.set(key, now);
  return true;
}

type AuthContext = {
  userId: string;
  username: string;
  displayName: string;
  accentColor: string;
  groupId: string;
};

function isAuthContext(x: unknown): x is AuthContext {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as AuthContext).groupId === 'string' &&
    typeof (x as AuthContext).userId === 'string'
  );
}

// ── Document naming: `${groupId}:${path}` ──────────────────────────────
//
// Hocuspocus keys its `documents` map by NAME ALONE (`Hocuspocus.ts`),
// and `createDocument()` returns an existing entry before `context` is
// ever consulted. An unqualified name therefore makes two worlds that
// happen to share a note path — `World Lore/index.md` exists in EVERY
// group, `Campaigns/<slug>/Characters/index.md` in every campaign —
// collaborate on ONE Y.Doc: each reads the other's body, and whichever
// typed last persists over the other's row. Qualifying the name is what
// separates them.
//
// The prefix on its own is decoration: the name arrives from the
// CLIENT, so an attacker can simply send `<victim-group>:World
// Lore/index.md` and rebuild the collision on purpose. `onAuthenticate`
// asserting `parsed.groupId === session.currentGroupId` is what makes
// it a boundary. Nothing downstream trusts the prefix for anything
// except as a map key.

/** Wire + `documents`-map name for a document. Group ids are
 *  `randomUUID()` or the literal `'default'`, so they never contain a
 *  colon. */
export function qualifiedDocName(groupId: string, path: string): string {
  return `${groupId}:${path}`;
}

/** Split a wire name back into its group id and BARE path.
 *
 *  Splits on the FIRST colon only. Note paths may legitimately contain
 *  colons (`isAllowedPath` constrains only the first segment) and the
 *  meta docs embed one by design (`graph-groups:<id>`,
 *  `.graph-state:<id>`), so `split(':')` would silently corrupt them.
 *
 *  Returns null for anything without a colon, with an empty group id,
 *  or with an empty path — including a pre-deploy client still sending
 *  a bare path. That is deliberate: a fallback to the bare name would
 *  keep the collision reachable for as long as one stale tab lives, so
 *  an unparseable name is a clean rejection instead. */
export function parseDocName(
  documentName: string,
): { groupId: string; path: string } | null {
  const sep = documentName.indexOf(':');
  if (sep <= 0) return null;
  const path = documentName.slice(sep + 1);
  if (path.length === 0) return null;
  return { groupId: documentName.slice(0, sep), path };
}

/** True for the two doc families that do NOT back onto a `notes` row:
 *  ephemeral `.`-channels (`.presence:<id>`, `.graph-state:<id>`) and
 *  the persistent `graph-groups:<id>` doc. Takes a BARE path. */
function isNonNoteDoc(path: string): boolean {
  return path.startsWith('.') || path.startsWith('graph-groups:');
}

/** Meta docs are graph-wide state (currently only groups). Naming
 *  convention: `graph-groups:<groupId>` — as the BARE path, i.e. the
 *  full wire name is `<groupId>:graph-groups:<groupId>`. The group id
 *  appears twice; the redundancy is kept because it gives the storage
 *  hooks a free second check that the two agree. Returning non-null
 *  means this doc goes to the graph_groups table, not the notes table. */
function parseMetaDocName(
  documentName: string,
): { kind: 'groups'; groupId: string } | null {
  const m = documentName.match(/^graph-groups:(.+)$/);
  if (!m) return null;
  return { kind: 'groups', groupId: m[1]! };
}

/** Return true when the given session should be allowed to write to
 *  the given hocuspocus document. Used to flip connections to
 *  read-only so a viewer can still join the collab session and see
 *  everyone else's updates without being able to push their own.
 *
 *    - admin / editor: full edit everywhere.
 *    - viewer: edit on notes they created OR on a PC they own
 *      (frontmatter player: matches their username).
 *    - ephemeral `.`-docs (presence, graph-state): editor/admin
 *      only so viewers don't write pins/colours. Awareness
 *      (cursors) still broadcasts under read-only.
 *    - `graph-groups:<id>`: editor/admin only — it's DM-configured
 *      colour grouping, not a per-user thing.
 */
function isNoteDmOnly(groupId: string, path: string): boolean {
  const row = getDb()
    .query<{ dm_only: number }, [string, string]>(
      'SELECT dm_only FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path);
  return !!row && row.dm_only === 1;
}

function isNoteGmOnly(groupId: string, path: string): boolean {
  const row = getDb()
    .query<{ gm_only: number }, [string, string]>(
      'SELECT gm_only FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path);
  return !!row && row.gm_only === 1;
}

/** `path` is the BARE note path — the caller has already stripped the
 *  group prefix and asserted it matches the session. */
function canEditDoc(path: string, session: Session): boolean {
  if (session.role === 'admin' || session.role === 'editor') return true;

  // Viewer path below.
  if (isNonNoteDoc(path)) return false;

  // Note path — allow if this user created the note OR owns the PC.
  const db = getDb();
  const note = db
    .query<{ created_by: string | null }, [string, string]>(
      'SELECT created_by FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, path);
  if (note && note.created_by === session.userId) return true;
  if (isPcOwnedBy(session.currentGroupId, path, session.userId)) {
    return true;
  }
  return false;
}

/** The DB-writing half of the Hocuspocus `store()` hook for a real
 *  note document (not a meta/graph doc, not an ephemeral `.`-doc).
 *  Extracted so tests can invoke the exact code path Hocuspocus uses
 *  without going through a WebSocket — see D1/H7 regression notes.
 *
 *  Everything here — including `computeDerived` — sits inside the
 *  try/catch. A throw from `computeDerived` (a Y.Doc whose 'default'
 *  key isn't the XmlFragment the editor writes, a malformed ProseMirror
 *  node reaching `pmToMarkdown`) must never escape this function:
 *  Hocuspocus's `storeDocumentHooks` rethrows after logging,
 *  which makes `useDebounce.run()` skip clearing `runningExecutions`,
 *  which pins `shouldUnloadDocument()` false forever for that doc,
 *  which stalls `closeDocumentForWrite` for the rest of the process —
 *  and since `run()` is invoked from a bare `setTimeout` with nobody
 *  awaiting the promise, the resulting unhandled rejection takes down
 *  the whole Node 22 process. The CPU work still has to run BEFORE the
 *  transaction opens (route handlers hold a separate SQLite connection
 *  and a long-held write lock stalls them up to `busy_timeout`) — it
 *  just also has to be caught. */
export function storeNoteDocument(opts: {
  /** BARE note path — NOT the qualified wire name. `computeDerived`,
   *  `persistDerived`, `deriveIndexesFor` and the `WHERE path = ?`
   *  below all key off it, so a prefixed value would corrupt link
   *  derivation and write a row under a bogus path. The group comes
   *  from `context.groupId`, which is the authenticated one. */
  path: string;
  state: Uint8Array;
  document: Y.Doc;
  context: { groupId: string; userId: string | null };
}): void {
  const { path, state, document, context } = opts;

  try {
    // CPU-heavy derivation. No DB access, but can throw on malformed
    // input — see the function comment above for why this must stay
    // inside the try.
    const derived = computeDerived({ path, doc: document });

    // yjs_state + the derived caches + the FTS triggers they fire
    // commit as ONE unit. Previously yjs_state landed immediately and
    // derive ran in a setImmediate with its own transaction — a crash
    // in between left search unable to find text the user could
    // already see synced.
    const db = getDb();
    db.transaction(() => {
      db.query(
        'UPDATE notes SET yjs_state = ?, updated_at = ?, updated_by = ? WHERE group_id = ? AND path = ?',
      ).run(state, Date.now(), context.userId, context.groupId, path);
      persistDerived({
        groupId: context.groupId,
        path,
        userId: context.userId,
        derived,
      });
    })();
  } catch (err) {
    // Atomic failure: NOTHING was written, including yjs_state. The
    // in-memory Y.Doc is untouched and the next debounce retries.
    // Loud on purpose — repeated failures (including a bad PM node
    // that throws inside computeDerived) mean the client's edits are
    // not reaching disk.
    console.error(`[collab] store failed for ${context.groupId}:${path}:`, err);
    void captureServer({
      userId: context.userId,
      groupId: context.groupId,
      event: EVENTS.API_ERROR,
      // Bare path: `groupId` is already a first-class field on the
      // event, so the qualified name would only duplicate it.
      properties: { route: 'collab.store', documentName: path },
    });
    return;
  }

  // Structured-index projection of frontmatter_json. Outside the
  // transaction on purpose — the store path never writes
  // frontmatter_json, so these tables can't be skewed by it, and
  // deriveCharacterFromFrontmatter opens its own transaction.
  deriveIndexesFor(context.groupId, path);

  // Signal graph clients to re-fetch — the note may have added or
  // removed wikilinks. After the commit so clients never re-fetch
  // mid-transaction.
  //
  // `documents` is keyed by the QUALIFIED name, so the lookup has to be
  // qualified too — the group id appears twice because the ephemeral
  // channel carries its own suffix (`.graph-state:<id>`).
  try {
    const graphStateDoc = collabServer.documents.get(
      qualifiedDocName(context.groupId, `.graph-state:${context.groupId}`),
    );
    if (graphStateDoc) {
      (graphStateDoc.getMap('meta') as Y.Map<number>).set(
        'graphDirty',
        Date.now(),
      );
    }
  } catch (err) {
    console.error(`[collab] graphDirty signal failed for ${path}:`, err);
  }

  // Throttled note_edited capture — one event per note per minute so a
  // fast typist doesn't flood PostHog. The key stays `group::path`:
  // `path` is bare here, so it still needs the group to be unique
  // across worlds that share a path.
  if (noteEditCaptureDue(`${context.groupId}::${path}`, Date.now())) {
    void captureServer({
      userId: context.userId,
      groupId: context.groupId,
      event: EVENTS.NOTE_EDITED,
      properties: { documentName: path, byte_size: state.byteLength },
    });
  }
}

// The Next.js route chunks and server.ts are separate webpack module
// graphs in the same process — `export const x = new Hocuspocus()` at
// module scope therefore constructs one instance PER BUNDLE, and a
// route's copy has an empty `documents` map forever. Pin the instance
// on globalThis (the only registry both graphs share) so routes,
// lib/ helpers and server.ts all address the live one.
//
// Dev caveat: hot-reloading this file will NOT rebuild the instance —
// changes to the hooks/extensions below need a full server restart.
const globalForCollab = globalThis as typeof globalThis & {
  __compendiumCollabServer?: Hocuspocus;
  __compendiumIssuedTokens?: WeakSet<ServerWriteToken>;
};

export const collabServer: Hocuspocus =
  globalForCollab.__compendiumCollabServer ??
  (globalForCollab.__compendiumCollabServer = new Hocuspocus({
  // Batch persistence: hold the `store()` call open for up to 200 ms
  // after the last edit, but never longer than 1.5 s. Without this,
  // every Y.Doc update from a fast typist triggers an immediate
  // `UPDATE notes SET yjs_state` plus the full derive/persist work —
  // dozens of writes per second per note. Peer broadcasts are
  // unaffected; this only debounces the disk write.
  debounce: 200,
  maxDebounce: 1500,
  async onAuthenticate(data): Promise<AuthContext> {
    const session = readSessionFromIncoming({
      headers: { cookie: data.request.headers.cookie },
    });
    if (!session) {
      void captureServer({
        event: EVENTS.COLLAB_AUTH_REJECTED,
        properties: { reason: 'no_session', documentName: data.documentName },
      });
      throw new Error('Unauthorized');
    }

    // ── THE TENANT BOUNDARY ─────────────────────────────────────────
    // The document name is CLIENT-SUPPLIED. Hocuspocus keys `documents`
    // by that name alone, so without this check an attacker sends
    // `<victim-group-uuid>:World Lore/index.md` and deliberately joins
    // the victim's Y.Doc — reading its body and, on the next store,
    // overwriting the victim's row. The `${groupId}:` prefix is only a
    // separator; THIS is what makes it a boundary.
    //
    // Also the rejection point for a stale pre-deploy tab still sending
    // a bare path (`parseDocName` → null). Clean rejection on purpose:
    // any fallback to bare names would keep the collision reachable for
    // as long as one old tab lives.
    const parsed = parseDocName(data.documentName);
    if (!parsed || parsed.groupId !== session.currentGroupId) {
      void captureServer({
        userId: session.userId,
        groupId: session.currentGroupId,
        event: EVENTS.COLLAB_AUTH_REJECTED,
        // Raw wire name here (not a bare path): when this fires it is
        // either a stale client or a targeted attempt, and the prefix
        // that was actually sent is the useful thing to see.
        properties: { reason: 'group_mismatch', documentName: data.documentName },
      });
      throw new Error('Unauthorized');
    }
    // Every check below runs on the BARE path. Nothing downstream reads
    // the prefix again — `session.currentGroupId` is the group of
    // record from here on.
    const path = parsed.path;

    // DM-only gate: block viewers from any note marked dm_only
    // entirely (they get no connection, so no live updates and no
    // awareness). Admins + editors see everything.
    if (
      session.role === 'viewer' &&
      !isNonNoteDoc(path) &&
      isNoteDmOnly(session.currentGroupId, path)
    ) {
      void captureServer({
        userId: session.userId,
        groupId: session.currentGroupId,
        event: EVENTS.COLLAB_AUTH_REJECTED,
        properties: { reason: 'dm_only_blocked', documentName: path },
      });
      throw new Error('Unauthorized');
    }

    // GM-only gate: GM-namespace notes are visible only to admins.
    // Editors and viewers are rejected at the protocol layer so no
    // live state ever ships to a player session.
    if (
      session.role !== 'admin' &&
      !isNonNoteDoc(path) &&
      isNoteGmOnly(session.currentGroupId, path)
    ) {
      void captureServer({
        userId: session.userId,
        groupId: session.currentGroupId,
        event: EVENTS.COLLAB_AUTH_REJECTED,
        properties: { reason: 'gm_only_blocked', documentName: path },
      });
      throw new Error('Unauthorized');
    }

    // Flip viewers to read-only for docs they don't own. They still
    // connect, still receive live updates from peers, just can't
    // broadcast their own document updates. Awareness (cursors) is
    // unaffected.
    const readOnly = !canEditDoc(path, session);
    if (readOnly) {
      data.connectionConfig.readOnly = true;
      void captureServer({
        userId: session.userId,
        groupId: session.currentGroupId,
        event: EVENTS.COLLAB_READONLY,
        properties: { documentName: path, role: session.role },
      });
    }

    // Record per-connection info so the disconnect hook can compute
    // duration. Keyed by socket AND document — see `connectionKey`.
    connectionInfo.set(connectionKey(data.socketId, data.documentName), {
      userId: session.userId,
      groupId: session.currentGroupId,
      path,
      connectedAt: Date.now(),
      readOnly,
    });

    return {
      userId: session.userId,
      username: session.username,
      displayName: session.displayName,
      accentColor: session.accentColor,
      groupId: session.currentGroupId,
    };
  },

  async onConnect(data): Promise<void> {
    const info = connectionInfo.get(connectionKey(data.socketId, data.documentName));
    if (!info) return;
    // `documents` is keyed by the qualified wire name — look up with
    // `data.documentName`, report with the bare path.
    const doc = collabServer.documents.get(data.documentName);
    const peerCount = doc ? doc.getConnectionsCount() : 1;
    void captureServer({
      userId: info.userId,
      groupId: info.groupId,
      event: EVENTS.COLLAB_CONNECTED,
      properties: {
        documentName: info.path,
        peer_count: peerCount,
        is_ephemeral: isNonNoteDoc(info.path),
      },
    });
  },

  async onDisconnect(data): Promise<void> {
    const key = connectionKey(data.socketId, data.documentName);
    const info = connectionInfo.get(key);
    connectionInfo.delete(key);
    if (!info) return;
    void captureServer({
      userId: info.userId,
      groupId: info.groupId,
      event: EVENTS.COLLAB_DISCONNECTED,
      properties: {
        documentName: info.path,
        duration_ms: Date.now() - info.connectedAt,
        read_only: info.readOnly,
        remaining_peers: data.clientsCount,
      },
    });
  },

  extensions: [
    new Logger({
      onLoadDocument: false,
      onStoreDocument: false,
      onConnect: true,
      onDisconnect: true,
      onUpgrade: false,
    }),
    new Database({
      fetch: async ({ documentName, context }): Promise<Uint8Array | null> => {
        if (!isAuthContext(context)) return null;
        // Defence in depth: `onAuthenticate` already refused any name
        // whose prefix isn't this connection's group, so a mismatch
        // here would mean the gate was bypassed. Strip and re-assert
        // rather than assume.
        const parsed = parseDocName(documentName);
        if (!parsed || parsed.groupId !== context.groupId) return null;
        const path = parsed.path;
        // Paths starting with "." are reserved awareness-only channels
        // (e.g. ".presence:<groupId>", ".graph-state:<groupId>"). They
        // don't back onto any row.
        if (path.startsWith('.')) return null;
        const meta = parseMetaDocName(path);
        if (meta) {
          if (meta.groupId !== context.groupId) return null;
          const row = getDb()
            .query<{ yjs_state: Uint8Array | null }, [string]>(
              'SELECT yjs_state FROM graph_groups WHERE group_id = ?',
            )
            .get(meta.groupId);
          return row?.yjs_state ? new Uint8Array(row.yjs_state) : null;
        }
        const row = getDb()
          .query<{ yjs_state: Uint8Array | null }, [string, string]>(
            'SELECT yjs_state FROM notes WHERE group_id = ? AND path = ?',
          )
          .get(context.groupId, path);
        if (!row?.yjs_state) return null;
        return new Uint8Array(row.yjs_state);
      },
      store: async ({ documentName, state, document, context }): Promise<void> => {
        if (!isAuthContext(context)) return;
        // Same re-assertion as `fetch` above — and here it also guards
        // the write side, so a name that somehow reached this hook
        // without matching the connection's group persists nothing.
        const parsed = parseDocName(documentName);
        if (!parsed || parsed.groupId !== context.groupId) return;
        const path = parsed.path;
        if (path.startsWith('.')) return;
        const meta = parseMetaDocName(path);
        if (meta) {
          if (meta.groupId !== context.groupId) return;
          getDb()
            .query(
              `INSERT INTO graph_groups (group_id, yjs_state, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(group_id) DO UPDATE SET
                 yjs_state = excluded.yjs_state,
                 updated_at = excluded.updated_at`,
            )
            .run(meta.groupId, state, Date.now());
          return;
        }
        // See storeNoteDocument() above — this is the exact function
        // Hocuspocus calls, extracted so it's directly unit-testable
        // without a WebSocket (D1 / H7). It takes the BARE path.
        storeNoteDocument({
          path,
          state,
          document,
          context: { groupId: context.groupId, userId: context.userId },
        });
      },
    }),
  ],
}));

/** Hand an established WebSocket to hocuspocus. Called from the
 *  upgrade handler in server.ts after the ws handshake completes. */
export function handleCollabConnection(ws: WebSocket, req: IncomingMessage): void {
  // Hocuspocus's .d.ts types handleConnection against its own WebSocket
  // shape; at runtime the ws package's server-side WebSocket satisfies
  // the duck-type (ping/pong/send/close etc). Cast through unknown to
  // keep TS quiet without losing type-safety elsewhere in the module.
  collabServer.handleConnection(ws as unknown as Parameters<typeof collabServer.handleConnection>[0], req);
}

// ── Server-side write coordination ─────────────────────────────────────
//
// Everything below depends on internals of the vendored
// `@hocuspocus/server` (3.4.4, `node_modules/@hocuspocus/server/src`).
// The relevant facts, so a future upgrade can re-check them:
//
//   • `Hocuspocus.documents` is the loaded-document map;
//     `Hocuspocus.loadingDocuments` holds the in-flight
//     `createDocument()` promise for a name that is being loaded. A
//     name is in exactly one of them (or neither), and
//     `loadingDocuments.set()` happens synchronously before the
//     `Database.fetch` hook can run — so "not in either map" really
//     does mean "no reader has touched the row yet".
//   • `Hocuspocus.closeConnections(name)` iterates `documents` ONLY.
//     Anything mid-load is invisible to it.
//   • `Connection.close()` removes the connection synchronously, but
//     the Hocuspocus-level onClose (the part that stores/unloads) runs
//     behind `await hooks('onDisconnect')` — hence the polling below
//     rather than a straight `await`.
//   • That onClose branches on `debouncer.isDebounced(...)`: if a store
//     is pending it calls `debouncer.executeNow(...)` (flush), else it
//     calls `unloadDocument()` (drop, no write). Which branch we get is
//     the entire difference between "clobbers the caller's write" and
//     "discards the stale doc".

/** Hocuspocus's debounce id for a document's pending `onStoreDocument`.
 *  Mirrors `Hocuspocus.storeDocumentHooks`. */
function storeDebounceId(documentName: string): string {
  return `onStoreDocument-${documentName}`;
}

/** The close event the client uses to recognise a server-initiated
 *  reset — `provider-cache.ts` discriminates on
 *  `event.reason === 'Reset Connection'`. Copied from
 *  `@hocuspocus/common`'s `ResetConnection` rather than imported: that
 *  package is a transitive dependency we don't declare, and the string
 *  is already hardcoded on the client side of the same contract. */
const RESET_CONNECTION = { code: 4205, reason: 'Reset Connection' } as const;

/** Opaque capability handle issued by `closeDocumentForWrite()` and
 *  consumed by the matching `closeDocumentConnections()`.
 *
 *  The only useful things a caller can do with one are hand it back (to
 *  consume it) or `releaseServerWrite()` it. `documentName` is exposed
 *  for logging and assertions only — it is NOT what makes a token
 *  valid; membership of the `issuedTokens` set (pinned on `globalThis`,
 *  see below) is. */
export type ServerWriteToken = {
  readonly documentName: string;
};

/** Every token this module has issued that has not yet been consumed or
 *  released.
 *
 *  This is the handshake between the two halves of a server write:
 *  `closeDocumentForWrite(path)` issues a token, and
 *  `closeDocumentConnections(path, token)` takes the DESTRUCTIVE path
 *  (discard the in-memory doc without storing) instead of the default
 *  one (evict, letting Hocuspocus flush) if — and only if — it is
 *  handed a live token this module issued for that same path.
 *
 *  Why it has to be conditional: the default flush-on-evict is the
 *  correct behaviour for every caller that is NOT replacing the body —
 *  `notes/visibility`, folder deletes, campaign deletes — where
 *  discarding would throw away up to `maxDebounce` of a user's real
 *  keystrokes for no reason. It is exactly the wrong behaviour after a
 *  body write, where the in-memory doc is known-stale. Only the caller
 *  knows which it is, and holding a token is that statement of intent.
 *
 *  This replaces an earlier `Map<path, expiry>` flag. A per-path flag
 *  had three failure modes that a per-call capability does not:
 *
 *    - LEAK. Any early return between the two halves left the path
 *      armed, so the next `closeDocumentConnections(path)` from ANY
 *      caller silently went destructive and dropped up to 1.5 s of a
 *      live editor's keystrokes that would otherwise have been flushed.
 *      A leaked token is inert: nobody else holds it, so nobody else
 *      can present it, and it is collected along with its holder.
 *    - MIS-PAIRING. With one flag per path, whichever caller arrived
 *      first consumed it. Two concurrent operations on the same path
 *      swapped halves: op B's evict consumed op A's arming, then op A's
 *      own post-write evict found nothing armed, took the plain path,
 *      and let Hocuspocus flush the PRE-write document over the row A
 *      had just committed. Tokens are distinct objects, so an operation
 *      can only ever consume the one it was issued.
 *    - TTL. Expiry was the flag's only leak guard, which forced it to
 *      be short (30 s) — shorter than `import-apply`'s own window,
 *      which contains an LLM merge call and routinely exceeds it. An
 *      expired mark silently downgraded that write to the stale-flush
 *      race it was there to prevent. There is no expiry any more:
 *      pairing is explicit, so expiry buys no safety, and a long
 *      operation is no longer exposed for running long.
 *
 *  A `WeakSet` rather than a `Set` so that a token whose holder threw
 *  without releasing it (a bug, but a survivable one) cannot grow this
 *  structure without bound — which is the only thing the TTL was
 *  actually protecting against.
 *
 *  Pinned on `globalThis` for the same reason as `collabServer` above:
 *  this module is instantiated once per webpack bundle (Next.js route
 *  chunks vs. server.ts are separate module graphs), so a plain
 *  module-scope `const` would produce one `issuedTokens` copy per
 *  bundle. Every current call site issues and consumes within the same
 *  module graph, so that's silently harmless today — a token minted in
 *  one copy would just never be found in another, downgrading the
 *  discard to a flush and logging a warning, not corrupting anything.
 *  But a future call site that issues in one graph and consumes in
 *  another would hit exactly that silent downgrade, so pin it now
 *  rather than waiting for that to happen. */
const issuedTokens = (globalForCollab.__compendiumIssuedTokens ??=
  new WeakSet<ServerWriteToken>());

/** How long the pre-write drain and the post-write discard each poll
 *  for Hocuspocus to let go of a document. */
const DRAIN_BUDGET_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Await `p`, but give up at `deadline` and return anyway.
 *
 *  Used for the `loadingDocuments` await inside the drain loop: that
 *  promise is `createDocument()`, which runs the `Database.fetch` hook
 *  and every `onLoadDocument` extension hook. A hung one (a wedged
 *  SQLite read, a third-party extension that never resolves) would
 *  otherwise pin the awaiting AI tool call or route handler forever —
 *  the loop only re-checks `DRAIN_BUDGET_MS` at the top, so it never
 *  gets the chance to time out. Returns `true` when `p` settled.
 *
 *  `p` is left running; callers pass an already-`.catch()`-ed promise so
 *  a late rejection can't surface as an unhandled one. */
async function settledByDeadline(p: Promise<unknown>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('timeout');
  try {
    const outcome = await Promise.race([
      p,
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), remaining);
      }),
    ]);
    return outcome !== timedOut;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Plain eviction: kick every live client on `documentName` and let
 *  Hocuspocus do whatever it normally does on the way out (which
 *  includes flushing a pending store). */
async function evictConnections(documentName: string): Promise<void> {
  try {
    collabServer.closeConnections(documentName);
  } catch (err) {
    console.warn('[collab] closeConnections failed:', err);
    void captureServer({
      event: EVENTS.API_ERROR,
      properties: { route: 'collab.closeConnections', documentName },
    });
  }
}

/** Cancel the pending debounced `onStoreDocument` for `documentName`
 *  WITHOUT executing it.
 *
 *  Hocuspocus's debouncer (`util/debounce.ts#useDebounce`) exposes no
 *  cancel primitive — its `timers` map is closed over, and the only
 *  escape hatch, `executeNow()`, *runs* the pending store. Re-arming
 *  the same debounce id with a no-op and a 0 ms delay is cancellation
 *  expressed in the API it does give us:
 *
 *    - `debounce()` starts by `clearTimeout`-ing the existing timer for
 *      the id, which unschedules the real store closure;
 *    - with `debounce === 0` it then runs our no-op immediately instead
 *      of re-registering a timer, so `timers` ends up empty for the id
 *      and `isDebounced()` goes false;
 *    - `run()` first awaits any execution already in flight for the id,
 *      so awaiting this also means "no store is mid-write right now".
 *
 *  Degradation: if a future Hocuspocus changes those semantics the
 *  worst case is that the store still fires — i.e. exactly the
 *  behaviour we have today — so this warns rather than throws. */
async function cancelPendingStore(documentName: string): Promise<void> {
  const id = storeDebounceId(documentName);
  try {
    await collabServer.debouncer.debounce(id, () => undefined, 0, 0);
  } catch (err) {
    console.warn(`[collab] cancelling pending store for ${documentName} failed:`, err);
  }
  if (collabServer.debouncer.isDebounced(id)) {
    console.warn(
      `[collab] pending store for ${documentName} survived cancellation — ` +
        'Hocuspocus debouncer internals may have changed',
    );
  }
}

/** Post-write teardown: get the in-memory document for `documentName`
 *  out of memory WITHOUT letting its (pre-write) state reach the DB.
 *
 *  This is the fix for the drain-timeout hole. When
 *  `closeDocumentForWrite()` times out, the document is still loaded
 *  holding PRE-write Y state with a pending debounced store. A plain
 *  eviction at that point drops the last connection, Hocuspocus calls
 *  `debouncer.executeNow()`, and the pre-write state is written
 *  straight back over the row the caller just updated — the eviction
 *  *causes* the clobber it was supposed to prevent. So we cancel the
 *  pending store first; with no timer left, Hocuspocus's onClose takes
 *  its other branch and calls `unloadDocument()`, which removes the doc
 *  from the map and destroys it without ever calling `store()`. The
 *  next reader loads fresh from the row we just wrote.
 *
 *  DATA-LOSS TRADE, accepted deliberately: cancelling the pending store
 *  discards up to `maxDebounce` (1.5 s) of un-flushed keystrokes from
 *  whoever was in the document. That is the right call here — the
 *  server-side write is the newer intent, the user has already been
 *  force-evicted by `closeDocumentForWrite()`, and the alternative is
 *  silently reverting the write. It costs at most a second of typing;
 *  the alternative costs the whole AI/import/move operation. Note this
 *  only ever runs on the path where the pre-write drain FAILED — on the
 *  happy path the document is already unloaded and its store already
 *  flushed, so nothing is discarded.
 *
 *  Residual risk we cannot close from here: a store that was ALREADY
 *  executing when the caller ran its UPDATE will still land on top of
 *  it. `cancelPendingStore()` waits that one out rather than racing it,
 *  and it is logged, but undoing it would require re-running the
 *  caller's write, which this function has no way to do. */
async function discardDocumentAfterWrite(documentName: string): Promise<void> {
  const deadline = Date.now() + DRAIN_BUDGET_MS;

  while (Date.now() < deadline) {
    // (N5) A document sitting in `loadingDocuments` is invisible to
    // both `documents` and `closeConnections()`. If its `Database.fetch`
    // ran before the caller's UPDATE it is about to land in `documents`
    // holding pre-write state, and — without this — nothing would ever
    // kick it again. Wait for the load to complete, then treat it like
    // any other stale document.
    const loading = collabServer.loadingDocuments.get(documentName);
    if (loading) {
      // Bounded by the same budget as the rest of the loop — see
      // `settledByDeadline`. Without the bound a wedged load hangs the
      // caller (an AI tool call or a route handler) indefinitely.
      const settled = await settledByDeadline(loading.catch(() => undefined), deadline);
      if (!settled) {
        console.warn(
          `[collab] ${documentName} was still loading ${DRAIN_BUDGET_MS}ms after a server write; ` +
            'abandoning the discard — the load will finish against the post-write row',
        );
        break;
      }
      // `createDocument()` inserts into `documents` in its own
      // continuation, and the Connection attaches one microtask after
      // that, so re-check rather than assuming either has happened.
      await sleep(0);
      continue;
    }

    const doc = collabServer.documents.get(documentName);
    if (!doc) return; // quiesced — anything loading from here reads post-write state

    await cancelPendingStore(documentName);
    await evictConnections(documentName);
    await sleep(10); // let onDisconnect → unloadDocument run
  }

  // Last resort: something is holding the document open past the
  // budget. Take it out of the map by hand so the next reader is
  // guaranteed to load the row we just wrote, then kick whatever is
  // still attached — those connections are no longer reachable via
  // `closeConnections()`, which only iterates `documents`.
  const stuck = collabServer.documents.get(documentName);
  if (!stuck) return;
  console.warn(
    `[collab] ${documentName} still loaded ${DRAIN_BUDGET_MS}ms after a server write; ` +
      'force-dropping the in-memory document (its unsaved edits are discarded)',
  );
  void captureServer({
    event: EVENTS.API_ERROR,
    properties: { route: 'collab.forceDropAfterWrite', documentName },
  });
  collabServer.documents.delete(documentName);
  for (const connection of stuck.getConnections()) {
    try {
      connection.close(RESET_CONNECTION);
    } catch {
      /* already gone */
    }
  }
  // Those closes may have scheduled one more store on the way out; the
  // doc is off the map now, so cancel again before destroying it. A
  // destroyed Y.Doc also makes any straggler's update throw inside
  // `MessageReceiver`, which Hocuspocus turns into a connection close —
  // a safe failure mode rather than a silent stale write.
  await cancelPendingStore(documentName);
  try {
    stuck.destroy();
  } catch {
    /* already destroyed */
  }
}

/** Force-close every live client editing a given path and evict the
 *  in-memory doc. Used by vault re-upload + note delete so clients
 *  reload fresh state rather than overwriting the new server state.
 *
 *  Two behaviours, selected by whether the caller presents the token
 *  `closeDocumentForWrite()` issued for this same path:
 *
 *  Token matching is on the QUALIFIED name, so a token issued for the
 *  same path in a DIFFERENT group is refused exactly like a token for a
 *  different path — a server write in one world can never authorise
 *  discarding another world's in-memory document.
 *
 *    - no token (or a token for a different path) — plain eviction.
 *      Hocuspocus flushes any pending store on the way out, so a user's
 *      last keystrokes are not lost. This is what every caller that did
 *      NOT replace the note body wants, and it is the default precisely
 *      so that forgetting a token costs data-freshness rather than
 *      data.
 *    - with this path's token — discard the in-memory document without
 *      storing it, because it holds pre-write state that would
 *      otherwise be written back over the caller's UPDATE. See
 *      `discardDocumentAfterWrite()` for the mechanism and the
 *      data-loss trade.
 *
 *  The token is consumed here: presenting it twice, or presenting one
 *  that was already `releaseServerWrite()`d, gets the plain path (and a
 *  warning — it means a caller lost track of its own handshake).
 *
 *  KNOWN-OPEN callers — read this before assuming a tokenless evict is
 *  proof the caller didn't replace the body. Several call sites DO
 *  replace a body and still evict without a token, so they get the
 *  plain flush and remain exposed to the original stale-flush clobber
 *  (a live editor's pending store landing on top of the rewrite):
 *
 *    - `lib/move-rewrite.ts#rewriteWikilinksForLinkers` rewrites
 *      `content_json` / `content_md` / `content_text` / `yjs_state` on
 *      every note that linked to a moved one, and is evicted without a
 *      token from `api/notes/move` and `lib/move-folder.ts`.
 *    - `lib/campaign-index.ts#deriveFolderIndex` rewrites the same four
 *      columns on the index note, then evicts without a token.
 *    - `api/admin/vault/upload` re-imports a whole vault and evicts
 *      every touched path without a token.
 *
 *  An earlier version of this comment cited "link rewrites" as an
 *  EXAMPLE of a caller for which flush-on-evict is correct. That was
 *  false, and stating a safety property that doesn't hold is worse than
 *  stating the gap. Closing it means threading a token through those
 *  modules — a separate change; nothing here made them worse. */
export async function closeDocumentConnections(
  groupId: string,
  path: string,
  token?: ServerWriteToken,
): Promise<void> {
  // Everything below addresses Hocuspocus's `documents` map, which is
  // keyed by the QUALIFIED name — an unqualified key would evict (or
  // destructively discard) the same path in every world at once.
  const documentName = qualifiedDocName(groupId, path);
  if (token !== undefined) {
    if (token.documentName !== documentName) {
      // Check the path BEFORE touching `issuedTokens`: a token
      // presented on the wrong path is not this call's to consume — if
      // we deleted it here, the caller holding the token for its real
      // path could never discard it there. Leaving it live also means
      // a wrong-path presentation can happen more than once without
      // burning the real path's one shot.
      console.warn(
        `[collab] server-write token for ${token.documentName} presented on ${documentName}; ` +
          'evicting with a flush instead',
      );
    } else if (!issuedTokens.delete(token)) {
      console.warn(
        `[collab] server-write token for ${token.documentName} was already consumed or ` +
          `released when presented on ${documentName}; evicting with a flush instead`,
      );
    } else {
      await discardDocumentAfterWrite(documentName);
      return;
    }
  }
  await evictConnections(documentName);
}

/** Discard a token without evicting anything.
 *
 *  Call this from a `finally` on every path that took a token, so an
 *  early return or a throw between the two halves cannot strand it.
 *  Idempotent, and a no-op after `closeDocumentConnections()` has
 *  already consumed the token — which is what makes the unconditional
 *  `finally { releaseServerWrite(token) }` shape at the call sites
 *  correct.
 *
 *  Releasing is the right move (rather than evicting anyway) whenever
 *  the write did not happen: no row changed, so nothing in memory is
 *  stale, and evicting would cost every open editor a ~1.2 s
 *  "Reconnecting…" panel for nothing. */
export function releaseServerWrite(token: ServerWriteToken): void {
  issuedTokens.delete(token);
}

/** Evict every live client on `documentName` AND wait until Hocuspocus
 *  has finished draining the document — including the debounced
 *  `store()` that fires when the last connection drops.
 *
 *  Call this BEFORE any server-side write that replaces a note's body
 *  or its `yjs_state`, and call `closeDocumentConnections()` on the same
 *  path AFTER the write. Plain `closeDocumentConnections()` alone is NOT
 *  enough: the flush runs on a microtask chain, so without the drain it
 *  can land AFTER your UPDATE and clobber it.
 *
 *  The two calls are a pair, not two independent safety nets — this one
 *  returns the token that tells the post-write call to DISCARD the
 *  in-memory document rather than let Hocuspocus flush it. Wrap the pair
 *  in `try { … } finally { releaseServerWrite(token) }` so that an early
 *  return or a throw in between always disposes of the token: a stranded
 *  one is inert (nobody else can present it), but the stale document is
 *  then left in memory until the next reader evicts it.
 *
 *  `documents.delete()` happens in the `finally` of storeDocumentHooks
 *  (via a `setTimeout(..., 0)`), so "no longer in the map" is an
 *  observable proxy for "fully drained".
 *
 *  The 500 ms cap does NOT stop a returning client from racing us, and
 *  is not meant to. The client's provider does wait ~1000 ms before
 *  retrying a dropped socket, but its `onClose` handler synchronously
 *  builds a BRAND-NEW provider, whose constructor dials with
 *  `initialDelay: 0` — so a client can be back within milliseconds.
 *  `provider-cache.ts` (`RESET_REACQUIRE_DELAY_MS`) is what actually
 *  keeps well-behaved clients out of the window; the post-write discard
 *  is what makes a badly-behaved one harmless. */
export async function closeDocumentForWrite(
  groupId: string,
  path: string,
): Promise<ServerWriteToken> {
  // The token carries the QUALIFIED name, which is both the map key
  // used below and what the matching `closeDocumentConnections()`
  // compares against — so the existing identity guard there scopes
  // tokens per world for free.
  const documentName = qualifiedDocName(groupId, path);
  // Issue the token before the early return: even if nothing is loaded
  // right now, a client can attach between here and the caller's
  // UPDATE, and the post-write call still has to discard it.
  const token: ServerWriteToken = { documentName };
  issuedTokens.add(token);

  if (
    !collabServer.documents.has(documentName) &&
    !collabServer.loadingDocuments.has(documentName)
  ) {
    return token;
  }
  await evictConnections(documentName);
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  while (collabServer.documents.has(documentName) && Date.now() < deadline) {
    await sleep(10);
  }
  if (collabServer.documents.has(documentName)) {
    // Not fatal any more: the post-write `closeDocumentConnections()`
    // discards the stale document instead of flushing it.
    console.warn(
      `[collab] ${documentName} still loaded ${DRAIN_BUDGET_MS}ms after close; ` +
        'writing anyway — the post-write discard will drop the stale doc',
    );
  }
  return token;
}

/** Tell every client with `path` open in `groupId` that its frontmatter
 *  (sheet) changed server-side, so they re-fetch it.
 *
 *  Frontmatter is a plain SQLite column, NOT part of the Y.Doc, so
 *  nothing about a frontmatter write reaches connected clients on its
 *  own — contrary to the note in .claude/rules/backend.md.
 *
 *  Writing a Y.Map key from the server broadcasts to all peers but
 *  does NOT trigger store(): Hocuspocus skips persistence when the
 *  Yjs transaction origin is null. Same mechanism as graphDirty.
 *
 *  No-op when nobody has the note open. */
export function signalSheetChanged(groupId: string, path: string): void {
  try {
    // Qualified: the un-prefixed lookup used to bump the `sheetMeta`
    // rev on whichever world's document happened to be resident under
    // that path.
    const doc = collabServer.documents.get(qualifiedDocName(groupId, path));
    if (!doc) return;
    (doc.getMap('sheetMeta') as Y.Map<number>).set('rev', Date.now());
  } catch (err) {
    console.warn('[collab] signalSheetChanged failed:', err);
  }
}
