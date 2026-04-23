// Module-level cache for Hocuspocus providers + their Y.Docs, keyed
// by note path. The point is to survive page-level unmounts (= tab
// switches): without this, every navigation between two open notes
// destroys the WS connection and re-syncs the doc from scratch, which
// is the bulk of the perceived "tab switching is slow" latency.
//
// Lifecycle model:
//   • `acquire(path)` returns the existing entry if cached, otherwise
//     constructs a fresh provider+ydoc and registers it. Bumps a ref
//     count so multiple consumers (e.g. NoteWorkspace + a peeking
//     CharacterSheet) can share a single connection.
//   • `release(path)` decrements the ref count. If the count hits 0
//     AND the path is not in the persistent set (tabs the user has
//     open), the entry is scheduled for destruction after IDLE_MS so
//     a quick away-and-back tap doesn't pay reconnection cost either.
//   • `setPersistentPaths(paths)` is the "tabs" channel — call from
//     NoteTabs whenever the open-tab list changes. Persistent paths
//     are never auto-destroyed; closing a tab moves it back into the
//     idle pool, where the timer can sweep it.
//
// This module is intentionally not React-aware: it's a plain cache
// that NoteWorkspace and NoteTabs poke at via the helpers below.

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

type Entry = {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  refCount: number;
  /** Pending destruction timer if the entry is idle and non-persistent. */
  destroyTimer: ReturnType<typeof setTimeout> | null;
};

const cache = new Map<string, Entry>();
const persistent = new Set<string>();

/** Grace period before destroying an idle non-persistent entry. Long
 *  enough to absorb a quick tab-flick away and back, short enough that
 *  zombie providers don't pile up if the user wanders off. */
const IDLE_MS = 30_000;

function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}

/** Acquire (or create) the cached provider+ydoc for `path`. Callers
 *  must pair every acquire with a release when they unmount. */
export function acquireProvider(path: string): { provider: HocuspocusProvider; ydoc: Y.Doc } {
  let entry = cache.get(path);
  if (!entry) {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: buildCollabUrl(),
      name: path,
      document: ydoc,
    });
    entry = { provider, ydoc, refCount: 0, destroyTimer: null };
    cache.set(path, entry);
  }
  // Cancel any pending sweep — the entry is in active use again.
  if (entry.destroyTimer) {
    clearTimeout(entry.destroyTimer);
    entry.destroyTimer = null;
  }
  entry.refCount += 1;
  return { provider: entry.provider, ydoc: entry.ydoc };
}

/** Release a previously-acquired entry. If no consumers remain and the
 *  path isn't pinned by an open tab, schedule destruction after the
 *  idle grace period. */
export function releaseProvider(path: string): void {
  const entry = cache.get(path);
  if (!entry) return;
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0) return;
  if (persistent.has(path)) return;
  scheduleDestroy(path, entry);
}

/** Update the set of paths that should never be auto-destroyed. The
 *  open-tabs list is the natural feed for this. Paths that drop out
 *  of the set become eligible for cleanup if they're also idle. */
export function setPersistentPaths(paths: Iterable<string>): void {
  const next = new Set<string>(paths);
  // Newly-pinned paths: cancel any pending destruction.
  for (const p of next) {
    if (persistent.has(p)) continue;
    const entry = cache.get(p);
    if (entry?.destroyTimer) {
      clearTimeout(entry.destroyTimer);
      entry.destroyTimer = null;
    }
  }
  // Newly-unpinned paths: if idle, schedule destruction.
  for (const p of persistent) {
    if (next.has(p)) continue;
    const entry = cache.get(p);
    if (entry && entry.refCount === 0) scheduleDestroy(p, entry);
  }
  persistent.clear();
  for (const p of next) persistent.add(p);
}

function scheduleDestroy(path: string, entry: Entry): void {
  if (entry.destroyTimer) return;
  entry.destroyTimer = setTimeout(() => {
    // Re-check at fire time — refCount or persistence may have changed.
    if (entry.refCount > 0 || persistent.has(path)) {
      entry.destroyTimer = null;
      return;
    }
    try {
      entry.provider.destroy();
    } catch {
      /* ignore */
    }
    try {
      entry.ydoc.destroy();
    } catch {
      /* ignore */
    }
    cache.delete(path);
  }, IDLE_MS);
}
