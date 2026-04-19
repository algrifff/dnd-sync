// Hocuspocus WebSocket server — handles live collaborative editing.
// Instantiated with `new Hocuspocus({...})` and mounted into the
// existing http server's upgrade path at /collab; we handle the
// WS handshake ourselves so session-cookie auth can run BEFORE
// hocuspocus loads the document.

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Logger } from '@hocuspocus/extension-logger';
import { getDb } from '@/lib/db';
import { readSessionFromIncoming, type Session } from '@/lib/session';
import { isPcOwnedBy } from '@/lib/characters';
import { deriveAndPersist } from './derive';

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
  async onAuthenticate(data): Promise<AuthContext> {
    const session = readSessionFromIncoming({
      headers: { cookie: data.request.headers.cookie },
    });
    if (!session) throw new Error('Unauthorized');

    // Flip viewers to read-only for docs they don't own. They still
    // connect, still receive live updates from peers, just can't
    // broadcast their own document updates. Awareness (cursors) is
    // unaffected.
    if (!canEditDoc(data.documentName, session)) {
      data.connectionConfig.readOnly = true;
    }

    return {
      userId: session.userId,
      username: session.username,
      displayName: session.displayName,
      accentColor: session.accentColor,
      groupId: session.currentGroupId,
    };
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
        try {
          deriveAndPersist({
            groupId: context.groupId,
            path: documentName,
            doc: document,
            userId: context.userId,
          });
        } catch (err) {
          console.error(`[collab] derive failed for ${documentName}:`, err);
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
  }
}
