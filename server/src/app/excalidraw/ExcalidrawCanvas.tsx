'use client';

// Excalidraw canvas bound to the note's shared Y.Doc via Hocuspocus.
// Persistence and realtime sync ride the same channel as TipTap notes —
// Hocuspocus's Database extension snapshots `yjs_state` on idle, and
// peer updates are broadcast to every connected client.
//
// Storage shape on the Y.Doc:
//   • Y.Array<unknown> at key 'excalidraw-elements' — the live element list.
//   • Y.Map<unknown>   at key 'excalidraw-appState' — viewBackgroundColor,
//     gridSize. Anything not in this allow-list is runtime-only.
//
// Conflict model: each onChange flushes the full element list into the
// Y.Array (replace-all under one transaction). Yjs computes a binary
// diff so wire cost stays modest. With a 150ms debounce, two users
// drawing simultaneously get last-writer-wins per stroke — acceptable
// for v1; element-level CRDT can come later if it matters.

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  acquireProvider,
  releaseProvider,
  onDocumentReset,
  RESET_REACQUIRE_DELAY_MS,
} from '../notes/provider-cache';
import '@excalidraw/excalidraw/index.css';

// React.lazy + Suspense instead of next/dynamic — Next 15's dynamic chunk
// URL generator trips encodeURIPath(undefined) when loading the Excalidraw
// package. React.lazy goes through plain webpack and works.
const Excalidraw = lazy(() => import('./ExcalidrawInner'));

type Scene = {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

type ExcalidrawAPI = {
  updateScene: (scene: { elements?: readonly unknown[]; appState?: Record<string, unknown> }) => void;
  getSceneElements: () => readonly unknown[];
};

const FLUSH_DEBOUNCE_MS = 150;

export function ExcalidrawCanvas({
  path,
  initialScene,
  canEdit,
}: {
  path: string;
  csrfToken: string;
  initialScene: Scene | null;
  canEdit: boolean;
}): React.JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [ready, setReady] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  // Tag local writes so the observer can skip echoing them back.
  const localOriginRef = useRef<object>({});
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingElementsRef = useRef<readonly unknown[] | null>(null);
  const pendingAppStateRef = useRef<Record<string, unknown> | null>(null);
  // Tracks the real invariant the legacy-scene seed needs, instead of
  // `epoch === 0`. Set to true the moment this path is observed with
  // real Yjs elements (at any epoch) OR once the seed below actually
  // runs. See the `onSynced` comment for why this — not the epoch
  // number — is the condition that keeps the reset-stomp protection
  // without the permanent-blank failure mode. Persists across resets
  // because it lives on the component instance, not inside the
  // per-epoch effect below.
  const seededRef = useRef(false);

  // Remount driver, mirroring NoteWorkspace: bumped whenever the server
  // evicts this document (an AI tool / import / move rewrote the note
  // that backs this canvas). The main acquire effect below depends on
  // it, so bumping it tears down the old provider binding and acquires
  // a fresh one.
  const [epoch, setEpoch] = useState(0);
  // True from the moment a reset is observed until the delayed
  // re-acquire below completes and a fresh `synced` fires. Drives the
  // status label and forces view-only mode so a mid-air stroke doesn't
  // get silently dropped into a doc that's about to be torn down.
  const [reconnecting, setReconnecting] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Server-initiated resets: same race this project's NoteWorkspace
  // guards against (see provider-cache.ts#RESET_REACQUIRE_DELAY_MS /
  // NoteWorkspace.tsx). Drop the refs to the doomed provider/ydoc
  // immediately so in-flight draws can't write into a torn-down Y.Doc,
  // then wait RESET_REACQUIRE_DELAY_MS — comfortably past the server's
  // `closeDocumentForWrite` 500ms drain cap — before bumping `epoch` to
  // re-run the acquire effect. Re-acquiring any sooner risks the same
  // stale-reload/silent-revert bug D2b fixed for the note editor.
  useEffect(() => {
    const unsubscribe = onDocumentReset((resetPath) => {
      if (resetPath !== path) return;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      ydocRef.current = null;
      providerRef.current = null;
      setReconnecting(true);
      setReady(false);
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        setEpoch((n) => n + 1);
      }, RESET_REACQUIRE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, [path]);

  useEffect(() => {
    const { provider, ydoc } = acquireProvider(path);
    ydocRef.current = ydoc;
    providerRef.current = provider;
    const yElements = ydoc.getArray<unknown>('excalidraw-elements');
    const yAppState = ydoc.getMap<unknown>('excalidraw-appState');
    const localOrigin = localOriginRef.current;

    const applyRemoteToScene = (): void => {
      const api = apiRef.current;
      if (!api) return;
      api.updateScene({
        elements: yElements.toArray() as readonly unknown[],
        appState: Object.fromEntries(yAppState.entries()) as Record<string, unknown>,
      });
    };

    const onElementsUpdate = (_evt: Y.YArrayEvent<unknown>, tx: Y.Transaction): void => {
      if (tx.origin === localOrigin) return;
      applyRemoteToScene();
    };
    const onAppStateUpdate = (_evt: Y.YMapEvent<unknown>, tx: Y.Transaction): void => {
      if (tx.origin === localOrigin) return;
      applyRemoteToScene();
    };
    yElements.observe(onElementsUpdate);
    yAppState.observe(onAppStateUpdate);

    const onSynced = (): void => {
      setStatus('live');
      // Seed Y from the legacy frontmatter snapshot if Y is empty but we
      // have a stored scene from before realtime collab landed.
      //
      // This used to gate on `epoch === 0` — "only the very first mount
      // can need seeding; any later reset means the Y state is
      // authoritative, so re-seeding from the load-time `initialScene`
      // prop would stomp that write with stale data." That holds when
      // the reset happens AFTER real content existed. It does NOT hold
      // if a reset fires before this path's elements were ever observed
      // non-empty — e.g. the doc gets evicted moments after mount,
      // before this seed had a chance to run. `epoch` has already
      // ticked past 0 by the time we re-sync, the gate stays shut
      // forever, and the canvas renders permanently blank — the first
      // stroke then persists that blank scene over the legacy snapshot
      // for good.
      //
      // `seededRef` tracks the real invariant instead: has this path,
      // in this component instance's lifetime, ever been seen with real
      // elements, or already been seeded? If yes, any later empty state
      // is a legitimate reset and must NOT be re-seeded (this preserves
      // the stomp protection the epoch gate existed for). If no —
      // including after any number of resets — the doc's emptiness has
      // never been confirmed genuine, so the legacy fallback stays live
      // until it either seeds or observes real content.
      if (yElements.length > 0) {
        seededRef.current = true;
      } else if (!seededRef.current && initialScene && initialScene.elements.length > 0) {
        ydoc.transact(() => {
          yElements.push(initialScene.elements as unknown[]);
          if (initialScene.appState) {
            for (const [k, v] of Object.entries(initialScene.appState)) {
              yAppState.set(k, v);
            }
          }
        }, localOrigin);
        seededRef.current = true;
      }
      // Push current Y state into the Excalidraw API once mounted.
      applyRemoteToScene();
      setReady(true);
      setReconnecting(false);
    };

    if (provider.synced) onSynced();
    else provider.on('synced', onSynced);

    const onStatus = (e: { status: string }): void => {
      if (e.status === 'connected') setStatus('live');
      else if (e.status === 'disconnected') setStatus('offline');
    };
    provider.on('status', onStatus);

    return () => {
      yElements.unobserve(onElementsUpdate);
      yAppState.unobserve(onAppStateUpdate);
      provider.off('synced', onSynced);
      provider.off('status', onStatus);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      releaseProvider(path);
    };
    // initialScene is a one-shot seed — don't re-trigger on identity
    // changes. `epoch` IS a real dependency: it's how a server-initiated
    // reset (see the effect above) forces this effect to release the
    // stale provider/ydoc and acquire a fresh one.
  }, [path, epoch]);

  const flushLocal = (): void => {
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    const yElements = ydoc.getArray<unknown>('excalidraw-elements');
    const yAppState = ydoc.getMap<unknown>('excalidraw-appState');
    const elements = pendingElementsRef.current;
    const appState = pendingAppStateRef.current;
    pendingElementsRef.current = null;
    pendingAppStateRef.current = null;
    ydoc.transact(() => {
      if (elements) {
        yElements.delete(0, yElements.length);
        yElements.push([...elements]);
      }
      if (appState) {
        for (const [k, v] of Object.entries(appState)) {
          yAppState.set(k, v);
        }
      }
    }, localOriginRef.current);
  };

  const handleChange = (
    elements: readonly unknown[],
    appState: Record<string, unknown>,
  ): void => {
    // `reconnecting` also blocks writes: `viewModeEnabled` (below) should
    // already stop Excalidraw from calling onChange for element edits
    // during this window, but appState-only changes (pan/zoom) can still
    // fire. `flushLocal` would no-op anyway once `ydocRef.current` is
    // null, but skipping here avoids buffering a stroke that's about to
    // be silently discarded.
    if (!canEdit || reconnecting) return;
    pendingElementsRef.current = elements;
    pendingAppStateRef.current = {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
    };
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushLocal, FLUSH_DEBOUNCE_MS);
  };

  return (
    <div className="relative h-[calc(100vh-7rem)] w-full">
      <div className="absolute right-3 top-3 z-10 rounded-md bg-[var(--parchment)]/85 px-2 py-1 text-[11px] text-[var(--ink-soft)] shadow">
        {reconnecting
          ? 'Reconnecting…'
          : status === 'connecting'
            ? 'Connecting…'
            : status === 'live'
              ? ready
                ? 'Live'
                : 'Syncing…'
              : status === 'offline'
                ? 'Offline'
                : null}
      </div>
      {mounted && (
        <Suspense fallback={null}>
          <Excalidraw
            excalidrawAPI={((api: unknown) => {
              apiRef.current = api as ExcalidrawAPI;
            }) as never}
            onChange={handleChange as never}
            viewModeEnabled={!canEdit || reconnecting}
          />
        </Suspense>
      )}
    </div>
  );
}
