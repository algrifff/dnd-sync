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
import { deriveAndPersist } from './derive';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

/** Per-socket bookkeeping so disconnect events can report a duration
 *  without hitting the DB. Keyed by Hocuspocus socketId (a string);
 *  entries are dropped in the onDisconnect hook. Stale entries would
 *  only accumulate on server crash — fine for a long-running process. */
type ConnectionInfo = {
  userId: string;
  groupId: string;
  documentName: string;
  connectedAt: number;
  readOnly: boolean;
};
const connectionInfo = new Map<string, ConnectionInfo>();

/** Throttle NOTE_EDITED events to once per note per 60s window so a
 *  typist doesn't spam PostHog with one event per debounced save. */
const lastEditCapture = new Map<string, number>();
const NOTE_EDIT_THROTTLE_MS = 60_000;

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

/** Meta docs are graph-wide state (currently only groups). Naming
 *  convention: `graph-groups:<groupId>`. Returning non-null means
 *  this doc goes to the graph_groups table, not the notes table. */
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
function isNoteDmOnly(groupId: string, documentName: string): boolean {
  const row = getDb()
    .query<{ dm_only: number }, [string, string]>(
      'SELECT dm_only FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, documentName);
  return !!row && row.dm_only === 1;
}

function isNoteGmOnly(groupId: string, documentName: string): boolean {
  const row = getDb()
    .query<{ gm_only: number }, [string, string]>(
      'SELECT gm_only FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, documentName);
  return !!row && row.gm_only === 1;
}

function canEditDoc(documentName: string, session: Session): boolean {
  if (session.role === 'admin' || session.role === 'editor') return true;

  // Viewer path below.
  if (documentName.startsWith('.')) return false;
  if (documentName.startsWith('graph-groups:')) return false;

  // Note path — allow if this user created the note OR owns the PC.
  const db = getDb();
  const note = db
    .query<{ created_by: string | null }, [string, string]>(
      'SELECT created_by FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, documentName);
  if (note && note.created_by === session.userId) return true;
  if (isPcOwnedBy(session.currentGroupId, documentName, session.userId)) {
    return true;
  }
  return false;
}

export const collabServer = new Hocuspocus({
  // Batch persistence: hold the `store()` call open for up to 200 ms
  // after the last edit, but never longer than 1.5 s. Without this,
  // every Y.Doc update from a fast typist triggers an immediate
  // `UPDATE notes SET yjs_state` plus the deriveAndPersist work —
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

    // DM-only gate: block viewers from any note marked dm_only
    // entirely (they get no connection, so no live updates and no
    // awareness). Admins + editors see everything.
    if (
      session.role === 'viewer' &&
      !data.documentName.startsWith('.') &&
      !data.documentName.startsWith('graph-groups:') &&
      isNoteDmOnly(session.currentGroupId, data.documentName)
    ) {
      void captureServer({
        userId: session.userId,
        groupId: session.currentGroupId,
        event: EVENTS.COLLAB_AUTH_REJECTED,
        properties: { reason: 'dm_only_blocked', documentName: data.documentName },
      });
      throw new Error('Unauthorized');
    }

    // GM-only gate: GM-namespace notes are visible only to admins.
    // Editors and viewers are rejected at the protocol layer so no
    // live state ever ships to a player session.
    if (
      session.role !== 'admin' &&
      !data.documentName.startsWith('.') &&
      !data.documentName.startsWith('graph-groups:') &&
      isNoteGmOnly(session.currentGroupId, data.documentName)
    ) {
      void captureServer({
        userId: session.userId,
        groupId: session.currentGroupId,
        event: EVENTS.COLLAB_AUTH_REJECTED,
        properties: { reason: 'gm_only_blocked', documentName: data.documentName },
      });
      throw new Error('Unauthorized');
    }

    // Flip viewers to read-only for docs they don't own. They still
    // connect, still receive live updates from peers, just can't
    // broadcast their own document updates. Awareness (cursors) is
    // unaffected.
    const readOnly = !canEditDoc(data.documentName, session);
    if (readOnly) {
      data.connectionConfig.readOnly = true;
      void captureServer({
        userId: session.userId,
        groupId: session.currentGroupId,
        event: EVENTS.COLLAB_READONLY,
        properties: { documentName: data.documentName, role: session.role },
      });
    }

    // Record per-socket connection info so the disconnect hook can
    // compute duration. Keyed by socketId — the one stable identifier
    // that appears in both onAuthenticate and onDisconnect payloads.
    connectionInfo.set(data.socketId, {
      userId: session.userId,
      groupId: session.currentGroupId,
      documentName: data.documentName,
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
    const info = connectionInfo.get(data.socketId);
    if (!info) return;
    const doc = collabServer.documents.get(data.documentName);
    const peerCount = doc ? doc.getConnectionsCount() : 1;
    void captureServer({
      userId: info.userId,
      groupId: info.groupId,
      event: EVENTS.COLLAB_CONNECTED,
      properties: {
        documentName: data.documentName,
        peer_count: peerCount,
        is_ephemeral: data.documentName.startsWith('.') || data.documentName.startsWith('graph-groups:'),
      },
    });
  },

  async onDisconnect(data): Promise<void> {
    const info = connectionInfo.get(data.socketId);
    connectionInfo.delete(data.socketId);
    if (!info) return;
    void captureServer({
      userId: info.userId,
      groupId: info.groupId,
      event: EVENTS.COLLAB_DISCONNECTED,
      properties: {
        documentName: info.documentName,
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
        // Doc names starting with "." are reserved awareness-only
        // channels (e.g. ".presence", ".graph-state:<groupId>"). They
        // don't back onto any row.
        if (documentName.startsWith('.')) return null;
        const meta = parseMetaDocName(documentName);
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
          .get(context.groupId, documentName);
        if (!row?.yjs_state) return null;
        return new Uint8Array(row.yjs_state);
      },
      store: async ({ documentName, state, document, context }): Promise<void> => {
        if (!isAuthContext(context)) return;
        if (documentName.startsWith('.')) return;
        const meta = parseMetaDocName(documentName);
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
        getDb()
          .query(
            'UPDATE notes SET yjs_state = ?, updated_at = ?, updated_by = ? WHERE group_id = ? AND path = ?',
          )
          .run(state, Date.now(), context.userId, context.groupId, documentName);
        // Derive runs asynchronously so it doesn't block the collab
        // server from broadcasting this update to other connected peers.
        setImmediate(() => {
          try {
            deriveAndPersist({
              groupId: context.groupId,
              path: documentName,
              doc: document,
              userId: context.userId,
            });
            // Signal graph clients to re-fetch — the note may have added or
            // removed wikilinks, so the graph data is now stale.
            const graphStateDoc = collabServer.documents.get(
              `.graph-state:${context.groupId}`,
            );
            if (graphStateDoc) {
              (graphStateDoc.getMap('meta') as Y.Map<number>).set(
                'graphDirty',
                Date.now(),
              );
            }
          } catch (err) {
            console.error(`[collab] derive failed for ${documentName}:`, err);
            void captureServer({
              userId: context.userId,
              groupId: context.groupId,
              event: EVENTS.API_ERROR,
              properties: { route: 'collab.derive', documentName },
            });
          }
        });

        // Throttled note_edited capture — one event per note per
        // minute so a fast typist doesn't flood PostHog.
        const editKey = `${context.groupId}::${documentName}`;
        const nowTs = Date.now();
        const lastTs = lastEditCapture.get(editKey) ?? 0;
        if (nowTs - lastTs >= NOTE_EDIT_THROTTLE_MS) {
          lastEditCapture.set(editKey, nowTs);
          void captureServer({
            userId: context.userId,
            groupId: context.groupId,
            event: EVENTS.NOTE_EDITED,
            properties: { documentName, byte_size: state.byteLength },
          });
        }
      },
    }),
  ],
});

/** Hand an established WebSocket to hocuspocus. Called from the
 *  upgrade handler in server.ts after the ws handshake completes. */
export function handleCollabConnection(ws: WebSocket, req: IncomingMessage): void {
  // Hocuspocus's .d.ts types handleConnection against its own WebSocket
  // shape; at runtime the ws package's server-side WebSocket satisfies
  // the duck-type (ping/pong/send/close etc). Cast through unknown to
  // keep TS quiet without losing type-safety elsewhere in the module.
  collabServer.handleConnection(ws as unknown as Parameters<typeof collabServer.handleConnection>[0], req);
}

/** Force-close every live client editing a given path and evict the
 *  in-memory doc. Used by vault re-upload + note delete so clients
 *  reload fresh state rather than overwriting the new server state. */
export async function closeDocumentConnections(documentName: string): Promise<void> {
  try {
    await collabServer.closeConnections(documentName);
  } catch (err) {
    console.warn('[collab] closeConnections failed:', err);
    void captureServer({
      event: EVENTS.API_ERROR,
      properties: { route: 'collab.closeConnections', documentName },
    });
  }
}
