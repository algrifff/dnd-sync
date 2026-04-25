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
import { acquireProvider, releaseProvider } from '../notes/provider-cache';
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
      if (yElements.length === 0 && initialScene && initialScene.elements.length > 0) {
        ydoc.transact(() => {
          yElements.push(initialScene.elements as unknown[]);
          if (initialScene.appState) {
            for (const [k, v] of Object.entries(initialScene.appState)) {
              yAppState.set(k, v);
            }
          }
        }, localOrigin);
      }
      // Push current Y state into the Excalidraw API once mounted.
      applyRemoteToScene();
      setReady(true);
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
    // initialScene is a one-shot seed — don't re-trigger on identity changes.
  }, [path]);

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
    if (!canEdit) return;
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
        {status === 'connecting' && 'Connecting…'}
        {status === 'live' && (ready ? 'Live' : 'Syncing…')}
        {status === 'offline' && 'Offline'}
      </div>
      {mounted && (
        <Suspense fallback={null}>
          <Excalidraw
            excalidrawAPI={((api: unknown) => {
              apiRef.current = api as ExcalidrawAPI;
            }) as never}
            onChange={handleChange as never}
            viewModeEnabled={!canEdit}
          />
        </Suspense>
      )}
    </div>
  );
}
