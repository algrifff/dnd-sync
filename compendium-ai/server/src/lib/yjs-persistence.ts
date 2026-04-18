// Loads and persists Yjs doc state through SQLite. Persistence is debounced
// per docName so bursty edits don't hammer disk — the last write wins once
// the timer settles.

import * as Y from 'yjs';
import { getDb } from './db';

const DEBOUNCE_MS = 300;
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePersist(docName: string, doc: Y.Doc): void {
  const existing = pendingTimers.get(docName);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingTimers.delete(docName);
    persistNow(docName, doc);
  }, DEBOUNCE_MS);
  pendingTimers.set(docName, t);
}

function persistNow(docName: string, doc: Y.Doc): void {
  const state = Y.encodeStateAsUpdate(doc);
  const textContent = doc.getText('content').toString();
  const now = Date.now();

  getDb()
    .query(
      `
        INSERT INTO text_docs (path, yjs_state, text_content, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          yjs_state    = excluded.yjs_state,
          text_content = excluded.text_content,
          updated_at   = excluded.updated_at
      `,
    )
    .run(docName, state, textContent, now);
}

/** Subscribe for future persists, then apply any stored state. Subscribing
 *  first is defensive: Y.applyUpdate can synchronously fire 'update' events
 *  during replay, and we want those captured even though replaying existing
 *  state into a fresh doc is a no-op persist. */
export function bindState(docName: string, doc: Y.Doc): void {
  doc.on('update', () => {
    schedulePersist(docName, doc);
  });

  const row = getDb()
    .query<{ yjs_state: Uint8Array }, [string]>('SELECT yjs_state FROM text_docs WHERE path = ?')
    .get(docName);

  if (row?.yjs_state) {
    Y.applyUpdate(doc, new Uint8Array(row.yjs_state));
  }
}

/** Force an immediate synchronous persist — used on connection close. */
export function writeStateNow(docName: string, doc: Y.Doc): void {
  const timer = pendingTimers.get(docName);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(docName);
  }
  persistNow(docName, doc);
}
