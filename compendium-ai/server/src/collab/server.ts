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
import { readSessionFromIncoming } from '@/lib/session';
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

export const collabServer = new Hocuspocus({
  async onAuthenticate(data): Promise<AuthContext> {
    const session = readSessionFromIncoming({
      headers: { cookie: data.request.headers.cookie },
    });
    if (!session) throw new Error('Unauthorized');
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
