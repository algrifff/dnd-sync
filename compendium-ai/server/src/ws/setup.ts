// Minimal Yjs WebSocket handler.
//
// Protocol: every message is a varUint message-type followed by a payload.
//   type 0 = sync protocol (y-protocols/sync)
//   type 1 = awareness protocol (y-protocols/awareness)
//
// Clients connect to  ws://host/sync/<encodeURIComponent(docName)>.
// One SharedDoc per docName is reused across all connected clients.

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WS_PATH } from '@compendium/shared';
import { bindState, writeStateNow } from '@/lib/yjs-persistence';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

type SharedDoc = {
  docName: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<WebSocket>;
};

const docs = new Map<string, SharedDoc>();

function broadcast(shared: SharedDoc, message: Uint8Array, origin: WebSocket | null): void {
  for (const conn of shared.conns) {
    if (conn !== origin && conn.readyState === conn.OPEN) {
      conn.send(message);
    }
  }
}

function getSharedDoc(docName: string): SharedDoc {
  let shared = docs.get(docName);
  if (shared) return shared;

  const doc = new Y.Doc({ gc: true });
  const awareness = new awarenessProtocol.Awareness(doc);
  const conns = new Set<WebSocket>();

  bindState(docName, doc);

  shared = { docName, doc, awareness, conns };
  docs.set(docName, shared);

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(shared!, encoding.toUint8Array(encoder), origin instanceof Object ? (origin as WebSocket) : null);
  });

  awareness.on(
    'update',
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      broadcast(shared!, encoding.toUint8Array(encoder), origin instanceof Object ? (origin as WebSocket) : null);
    },
  );

  return shared;
}

function extractDocName(req: IncomingMessage): string | null {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const prefix = `${WS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  const docName = extractDocName(req);
  if (!docName) {
    ws.close(1008, 'missing doc name in path');
    return;
  }

  const shared = getSharedDoc(docName);
  shared.conns.add(ws);
  ws.binaryType = 'arraybuffer';

  ws.on('message', (data: ArrayBuffer | Buffer) => {
    try {
      const bytes =
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const decoder = decoding.createDecoder(bytes);
      const type = decoding.readVarUint(decoder);

      switch (type) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, shared.doc, ws);
          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }
          break;
        }
        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            shared.awareness,
            decoding.readVarUint8Array(decoder),
            ws,
          );
          break;
        }
        default:
          console.warn(`[ws] unknown message type ${type} on ${shared.docName}`);
      }
    } catch (err) {
      console.error(`[ws] message error on ${shared.docName}:`, err);
    }
  });

  ws.on('close', () => {
    shared.conns.delete(ws);
    // Drop the client's awareness state so peers stop seeing their cursor.
    awarenessProtocol.removeAwarenessStates(
      shared.awareness,
      [...shared.awareness.getStates().keys()].filter(
        (clientId) => clientId !== shared.doc.clientID,
      ),
      null,
    );
    // Final flush so anything in the debounce window lands on disk.
    writeStateNow(shared.docName, shared.doc);
  });

  // Send the initial sync step 1 and current awareness to the new client.
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(syncEncoder, shared.doc);
  ws.send(encoding.toUint8Array(syncEncoder));

  const states = shared.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(shared.awareness, [...states.keys()]),
    );
    ws.send(encoding.toUint8Array(awarenessEncoder));
  }
}
