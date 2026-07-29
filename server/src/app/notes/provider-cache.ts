// Module-level cache for Hocuspocus providers + their Y.Docs, keyed
// by `${groupId}:${path}` (the SAME qualified name used as the
// Hocuspocus document name — see `@/collab/server`). The point is to
// survive page-level unmounts (= tab switches): without this, every
// navigation between two open notes destroys the WS connection and
// re-syncs the doc from scratch, which is the bulk of the perceived
// "tab switching is slow" latency.
//
// The `groupId` qualifier exists to prevent a cross-tenant collision:
// two worlds can and routinely do have a note at the identical path
// (e.g. every group gets its own `World Lore/index.md`). Before this
// qualifier, two different worlds' tabs open in the same browser
// session (or even just two tabs on two different worlds) would
// resolve to the SAME cache entry — the same Y.Doc — and each would
// silently read/write the other's content. See the tenant-isolation
// spec for the full writeup. Every entry point below now takes
// `groupId` explicitly; never accept a bare path in isolation.
//
// Lifecycle model:
//   • `acquireProvider(groupId, path)` returns the existing entry if
//     cached, otherwise constructs a fresh provider+ydoc and registers
//     it. Bumps a ref count so multiple consumers (e.g. NoteWorkspace
//     + a peeking CharacterSheet) can share a single connection.
//   • `releaseProvider(groupId, path)` decrements the ref count. If
//     the count hits 0 AND the qualified name is not in the persistent
//     set (tabs the user has open), the entry is scheduled for
//     destruction after IDLE_MS so a quick away-and-back tap doesn't
//     pay reconnection cost either.
//   • `setPersistentPaths(groupId, paths)` is the "tabs" channel — call
//     from NoteTabs whenever the open-tab list changes. Persistent
//     paths are never auto-destroyed; closing a tab moves it back into
//     the idle pool, where the timer can sweep it.
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

/** Both keyed by the QUALIFIED name (`${groupId}:${path}`) — never a
 *  bare path. See the module banner comment for why. */
const cache = new Map<string, Entry>();
const persistent = new Set<string>();

/** Build the qualified document/cache-key name from a group and a bare
 *  note path. Parse the other direction on the FIRST colon only if you
 *  ever need to (note paths may themselves contain colons; group ids
 *  never do) — nothing here currently needs to un-qualify, but keep
 *  that constraint in mind if you add something that does. */
function qualify(groupId: string, path: string): string {
  return `${groupId}:${path}`;
}

/** Grace period before destroying an idle non-persistent entry. Long
 *  enough to absorb a quick tab-flick away and back, short enough that
 *  zombie providers don't pile up if the user wanders off. */
const IDLE_MS = 30_000;

/** Minimum delay every `onDocumentReset` subscriber must wait before
 *  calling `acquireProvider` again for the reset path.
 *
 *  This must stay comfortably above the 500ms cap in
 *  `closeDocumentForWrite` (server/src/collab/server.ts). That function
 *  evicts live editors, then polls up to 500ms for the document to
 *  fully unload before its caller overwrites `yjs_state` in the DB —
 *  its own comment claims a returning client can't race that drain
 *  because the provider's reconnect delay is 1000ms. That's wrong: the
 *  vendored `HocuspocusProviderWebsocket` defaults to `autoConnect:
 *  true` and `initialDelay: 0`, and dials immediately in its
 *  constructor. The `delay: 1000` option is the *retry* backoff for an
 *  already-established connection that drops, not the first dial. So a
 *  consumer that re-acquires the instant `onDocumentReset` fires can
 *  reconnect within milliseconds — Hocuspocus reloads the PRE-write
 *  `yjs_state` into memory, the server's drain times out ("still
 *  loaded 500ms after close; writing anyway"), the write lands anyway,
 *  and the next local edit persists the now-stale in-memory doc,
 *  silently reverting whatever the server just wrote.
 *
 *  Every subscriber of `onDocumentReset` (NoteWorkspace, ExcalidrawCanvas)
 *  must wait at least this long before calling `acquireProvider` again.
 *  Do NOT tune this down to "optimise" reconnect latency — it exists
 *  specifically to lose the race against the server's drain, not to win
 *  it faster. */
export const RESET_REACQUIRE_DELAY_MS = 1200;

function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}

/** Callers subscribed via `onDocumentReset`. Receives the QUALIFIED
 *  name (`${groupId}:${path}`) — the same string used as the cache key
 *  — NOT the bare path. Every subscriber must build the same qualified
 *  name from its own `(groupId, path)` props before comparing, or the
 *  reset notification will silently never match and resets will stop
 *  working for that consumer. */
type ResetListener = (qualifiedName: string) => void;
const resetListeners = new Set<ResetListener>();

/** Subscribe to server-initiated document resets (see `evict` below).
 *  NoteWorkspace uses this to remount with a fresh Y.Doc so Tiptap
 *  rebinds against clean server state instead of the stale, evicted
 *  one. Returns an unsubscribe function. */
export function onDocumentReset(fn: ResetListener): () => void {
  resetListeners.add(fn);
  return () => {
    resetListeners.delete(fn);
  };
}

/** Tear down the cached provider + Y.Doc for `qualifiedName` so the
 *  next `acquireProvider` call builds a clean one that loads server
 *  state from scratch, and notify subscribers so they can remount.
 *  `qualifiedName` is the cache key (`${groupId}:${path}`), not a bare
 *  path — see the module banner comment.
 *
 *  Idempotent per qualified name — see the early-return comment below
 *  for why that's required, not just defensive. */
function evict(qualifiedName: string): void {
  const entry = cache.get(qualifiedName);
  if (!entry) {
    // Already evicted for this path — no-op, including the listener
    // notification below. This isn't just defensive: `onClose` above
    // fires this function TWICE per server-initiated "Reset
    // Connection" close in practice.
    // `HocuspocusProvider.setConfiguration` forwards the whole config
    // (including our `onClose`) into `new HocuspocusProviderWebsocket(
    // ...)`, so the handler ends up registered on the websocket
    // emitter twice — once by the websocket constructor, once by
    // `HocuspocusProvider.attach()`. Hocuspocus's `EventEmitter.emit`
    // iterates a captured array reference, so `provider.destroy()`'s
    // `removeAllListeners()` (called synchronously below, before this
    // event finishes dispatching) can't stop the second invocation
    // that's already mid-flight. Without this guard, the second call
    // would re-run the listener-notification loop and every
    // `onDocumentReset` subscriber (NoteWorkspace, ExcalidrawCanvas)
    // would re-clear its pending re-acquire timer and reschedule a
    // redundant one — currently harmless only because every subscriber
    // happens to guard with `clearTimeout` first, which is incidental,
    // not a contract. Do not "simplify" this guard away.
    return;
  }
  if (entry.destroyTimer) clearTimeout(entry.destroyTimer);
  try {
    entry.provider.destroy();
  } catch {
    /* ignore */
  }
  cache.delete(qualifiedName);
  // Defer the Y.Doc's own destruction to a macrotask instead of doing
  // it inline here. Subscribers below react to this eviction with a
  // React state update (e.g. NoteWorkspace swaps in a placeholder
  // instead of <NoteSurface>) — in every major browser today, React's
  // Scheduler (which uses a `MessageChannel` callback) runs that commit
  // before a `setTimeout(0)` callback fires, so in practice the render/
  // unmount lands before this timer does. That is NOT a spec guarantee
  // — nothing stops a `MessageChannel` callback from losing that race
  // (e.g. a concurrent-render yield reordering the commit), and
  // definitely not a guarantee that the commit lands before this
  // synchronous function even returns. So: this only NARROWS the use-
  // after-destroy window, it doesn't close it. If we destroyed the doc
  // inline instead, Tiptap's Collaboration extension could still be
  // bound to it for that in-between window and throw the next time it
  // touches a destroyed Y.Doc (e.g. a queued awareness update). The
  // cache entry is already gone by the time this timer fires, so a
  // fresh `acquireProvider` for the same path is unaffected — this only
  // tears down the orphaned doc object itself.
  setTimeout(() => {
    try {
      entry.ydoc.destroy();
    } catch {
      /* ignore */
    }
  }, 0);
  for (const fn of resetListeners) {
    try {
      fn(qualifiedName);
    } catch {
      /* ignore — one bad listener shouldn't break the others */
    }
  }
}

/** Acquire (or create) the cached provider+ydoc for `path` within
 *  `groupId`. Callers must pair every acquire with a release (same
 *  `groupId`/`path` pair) when they unmount.
 *
 *  `groupId` MUST be the caller's own `session.currentGroupId`, passed
 *  down as a prop from the server layout/page — never refetched or
 *  derived client-side. The qualified name (`${groupId}:${path}`) is
 *  both the cache key here AND the Hocuspocus document name sent over
 *  the wire; the server asserts the group segment matches the
 *  connecting session (`onAuthenticate` in `@/collab/server`), so a
 *  wrong or stale `groupId` here fails closed as a rejected connection
 *  rather than silently reading the wrong tenant's document.
 *
 *  INVARIANT: any component holding a handle from this function must
 *  also subscribe to `onDocumentReset` and stop using (or remount away
 *  from) the returned provider/ydoc when it fires for their qualified
 *  name. The server can evict and destroy the cached entry out from
 *  under a holder at any time (AI tools, imports, moves, visibility
 *  changes — see `closeDocumentForWrite`/`closeDocumentConnections` in
 *  `@/collab/server`); a component that doesn't subscribe is left
 *  holding a destroyed provider/ydoc with no way back. `NoteWorkspace`
 *  and `ExcalidrawCanvas` are both current subscribers — copy their
 *  pattern (drop the reference immediately, wait
 *  `RESET_REACQUIRE_DELAY_MS`, then re-acquire) for any new consumer. */
export function acquireProvider(
  groupId: string,
  path: string,
): { provider: HocuspocusProvider; ydoc: Y.Doc } {
  const qualifiedName = qualify(groupId, path);
  let entry = cache.get(qualifiedName);
  if (!entry) {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: buildCollabUrl(),
      name: qualifiedName,
      document: ydoc,
      // The server evicts us (closeDocumentConnections /
      // closeDocumentForWrite) when it's about to replace this note's
      // body from outside the CRDT — AI tools, imports, wikilink
      // rewrites. Hocuspocus only marks the provider unsynced on this;
      // the stale Y.Doc survives, and a later re-sync would push it
      // back and undo the server's write. Evict the cache entry so the
      // next acquire starts clean.
      //
      // The CLOSE message hardcodes `code: 1000` client-side (see
      // MessageReceiver.ts in the vendored provider), so `event.reason`
      // is the ONLY usable discriminator — matching on `code` would
      // treat every normal close as a reset.
      onClose: ({ event }) => {
        if (event?.reason !== 'Reset Connection') return;
        evict(qualifiedName);
      },
    });
    entry = { provider, ydoc, refCount: 0, destroyTimer: null };
    cache.set(qualifiedName, entry);
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
 *  qualified name isn't pinned by an open tab, schedule destruction
 *  after the idle grace period. */
export function releaseProvider(groupId: string, path: string): void {
  const qualifiedName = qualify(groupId, path);
  const entry = cache.get(qualifiedName);
  if (!entry) return;
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0) return;
  if (persistent.has(qualifiedName)) return;
  scheduleDestroy(qualifiedName, entry);
}

/** Update the set of paths (within `groupId`) that should never be
 *  auto-destroyed. The open-tabs list is the natural feed for this.
 *  Paths that drop out of the set become eligible for cleanup if
 *  they're also idle.
 *
 *  Takes a single `groupId` because the tab strip is rendered from a
 *  single server layout for the caller's current group — every open
 *  tab belongs to that group's session. */
export function setPersistentPaths(groupId: string, paths: Iterable<string>): void {
  const next = new Set<string>();
  for (const p of paths) next.add(qualify(groupId, p));
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

function scheduleDestroy(qualifiedName: string, entry: Entry): void {
  if (entry.destroyTimer) return;
  entry.destroyTimer = setTimeout(() => {
    // Re-check at fire time — refCount or persistence may have changed.
    if (entry.refCount > 0 || persistent.has(qualifiedName)) {
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
    cache.delete(qualifiedName);
  }, IDLE_MS);
}
