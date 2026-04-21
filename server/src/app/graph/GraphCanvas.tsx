'use client';

// Full-viewport mind-map.
//
// Stack:
//   * graphology       — in-memory graph model
//   * forceatlas2      — physics layout. Runs continuously in a
//                        requestAnimationFrame loop on the main
//                        thread (the /worker variant has ESM/CJS
//                        edges under Next); each frame performs one
//                        iteration and overrides pinned / dragged
//                        node positions after the step.
//   * sigma            — WebGL renderer
//
// Interactions:
//   * drag a node      → hold its position at the cursor; physics
//                        keeps running so the rest of the graph
//                        settles around it (Obsidian style).
//   * shift-drag       → same as drag, plus the final position is
//                        persisted to localStorage (pinned) — the
//                        node is force-fixed every frame forever
//                        until unpinned.
//   * click a node     → navigate to /notes/<path>
//   * hover            → fade non-neighbours, pop linked edges
//
// Controls (top-left):
//   * scope            — all / tag:<tag>
//   * zoom / fit / unpin
//   * labels           — none / some / all
//   * colours          — per-tag override picker (persisted per group)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { colorForTags, radiusForDegree } from './graphStyle';
import { NotePicker } from '../notes/NotePicker';

type RemoteGraphCursor = {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  cursorMode: 'color' | 'image';
  avatarVersion: number;
  // Graph-space coordinates (sigma's internal system). Converted to
  // viewport pixels each frame via renderer.graphToViewport.
  gx: number;
  gy: number;
};

type GraphPayload = {
  nodes: Array<{ id: string; title: string; tags: string[]; degree: number }>;
  edges: Array<{ source: string; target: string }>;
};

type Scope =
  | { kind: 'all' }
  | { kind: 'tag'; tag: string };

type LabelMode = 'none' | 'some' | 'all';

/** A user-defined group of tags and/or notes painted with a single
 *  colour. Groups take priority over individual tag-colour overrides
 *  so you can narrow a big palette down to collective buckets
 *  ("factions", "party", etc.). Stored as-is in a Y.Map on the
 *  shared graph state — every peer sees the same groups live. */
type Group = {
  id: string;
  name: string;
  color: string;
  tags: string[];
  notes: string[];
};

// Label mode stays local per viewer (personal preference). Two
// shared Y.Docs back the live collaboration:
//
//   * Ephemeral: `.graph-state:<groupId>` — pins, colours, anchors,
//     and awareness (cursors, drags). The `.`-prefix makes hocuspocus
//     skip persistence, so this Y.Doc lives only while at least one
//     peer has the graph open and resets when the last one leaves.
//
//   * Persistent: `graph-groups:<groupId>` — user-defined colour
//     groups. These are saved to the graph_groups table so they
//     survive across sessions and reloads.
//
// Both doc names include the groupId so different vaults don't
// share state.
const LABEL_STORAGE_PREFIX = 'compendium.graph.labels.';

const GRAPH_SCOPE_ID = 'graph-canvas-scope';

export function GraphCanvas({
  groupId,
  allTags,
  me,
  csrfToken,
}: {
  groupId: string;
  allTags: string[];
  me: {
    userId: string;
    displayName: string;
    accentColor: string;
    cursorMode: 'color' | 'image';
    avatarVersion: number;
  };
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const rafRef = useRef<number>(0);
  const pinsRef = useRef<Record<string, { x: number; y: number }>>({});
  const anchorsRef = useRef<Record<string, { x: number; y: number }>>({});
  const draggedRef = useRef<{ node: string; x: number; y: number } | null>(null);
  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ nodes: number; edges: number }>({
    nodes: 0,
    edges: 0,
  });
  const [labelMode, setLabelMode] = useState<LabelMode>('some');
  const [tagColors, setTagColors] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [palette, setPalette] = useState<boolean>(false);
  const [nodesPayload, setNodesPayload] = useState<GraphPayload['nodes']>([]);
  const [remoteCursors, setRemoteCursors] = useState<RemoteGraphCursor[]>([]);
  // Bumped on every sigma render so the overlay rerenders the peer
  // cursors at their latest screen positions (camera pan/zoom,
  // dragged nodes, physics — all update the graph→viewport mapping).
  const [renderTick, setRenderTick] = useState<number>(0);
  // Incremented when the server signals that note_links changed so we
  // re-fetch graph data without a full page reload.
  const [graphVersion, setGraphVersion] = useState<number>(0);
  const [nodeScale, setNodeScale] = useState<number>(1);
  const nodeScaleRef = useRef<number>(1);

  // Link-draw mode: toggle button switches between pan/drag and
  // rubber-band link creation. Refs keep the interaction handlers
  // (defined once in the main effect) up-to-date without re-running.
  const [linkMode, setLinkMode] = useState<boolean>(false);
  const linkModeRef = useRef<boolean>(false);
  const linkSourceRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const [rubberBand, setRubberBand] = useState<{
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);

  // ── shared graph state (synced across connected peers) ─────────────
  // Two providers: one ephemeral (pins/colours/anchors/awareness),
  // one persistent (groups). See the comment above LABEL_STORAGE_PREFIX.
  const ydoc = useMemo(() => new Y.Doc(), []);
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: buildCollabUrl(),
        name: `.graph-state:${groupId}`,
        document: ydoc,
      }),
    [ydoc, groupId],
  );
  const groupsYdoc = useMemo(() => new Y.Doc(), [groupId]);
  const groupsProvider = useMemo(
    () =>
      new HocuspocusProvider({
        url: buildCollabUrl(),
        name: `graph-groups:${groupId}`,
        document: groupsYdoc,
      }),
    [groupsYdoc, groupId],
  );
  const pinsMap = useMemo(
    () => ydoc.getMap<{ x: number; y: number }>('pins'),
    [ydoc],
  );
  // Soft anchors — plain-drag release writes the drop position here.
  // Physics keeps running on the node, but each tick pulls it gently
  // toward the anchor (see ANCHOR_STRENGTH below), so the node
  // hovers around where it was dropped instead of snapping back to
  // the equilibrium position FA2 would otherwise pick. Shift-drag
  // writes a hard pin (see pinsMap) and clears any anchor.
  const anchorsMap = useMemo(
    () => ydoc.getMap<{ x: number; y: number }>('anchors'),
    [ydoc],
  );
  const coloursMap = useMemo(() => ydoc.getMap<string>('colours'), [ydoc]);
  const metaMap = useMemo(() => ydoc.getMap<number>('meta'), [ydoc]);
  const groupsMap = useMemo(
    () => groupsYdoc.getMap<Group>('groups'),
    [groupsYdoc],
  );

  // Re-fetch graph data when the server signals note_links changed.
  useEffect(() => {
    const onMeta = (): void => {
      if (metaMap.has('graphDirty')) setGraphVersion((v) => v + 1);
    };
    metaMap.observe(onMeta);
    return () => metaMap.unobserve(onMeta);
  }, [metaMap]);

  useEffect(() => {
    return () => {
      provider.destroy();
      ydoc.destroy();
      groupsProvider.destroy();
      groupsYdoc.destroy();
    };
  }, [provider, ydoc, groupsProvider, groupsYdoc]);

  const scopeParam = useMemo(() => {
    if (scope.kind === 'tag') return `tag:${scope.tag}`;
    return 'all';
  }, [scope]);

  // Resolve a node's colour in this order:
  //   1. group membership — first matching group wins. A node matches
  //      if its path is in the group's notes list OR any of its tags
  //      are in the group's tags list.
  //   2. per-tag override from the Colours palette.
  //   3. default priority palette from graphStyle.
  const colorFor = useCallback(
    (nodeId: string, tags: readonly string[]): string => {
      const lower = tags.map((t) => t.toLowerCase());
      for (const g of groups) {
        if (g.notes.includes(nodeId)) return g.color;
        for (const t of g.tags) {
          if (lower.includes(t.toLowerCase())) return g.color;
        }
      }
      for (const t of tags) {
        const override = tagColors[t.toLowerCase()];
        if (override) return override;
      }
      return colorForTags(tags);
    },
    [groups, tagColors],
  );

  // Label mode: personal preference, local to this viewer.
  useEffect(() => {
    try {
      const mode = localStorage.getItem(LABEL_STORAGE_PREFIX + groupId) as LabelMode | null;
      if (mode === 'none' || mode === 'some' || mode === 'all') setLabelMode(mode);
    } catch {
      /* ignore */
    }
  }, [groupId]);
  useEffect(() => {
    try {
      localStorage.setItem(LABEL_STORAGE_PREFIX + groupId, labelMode);
    } catch {
      /* ignore */
    }
  }, [labelMode, groupId]);

  // Pins: shared via Y.Map. Mirror into a ref for the physics loop
  // (fast read without round-tripping through Y on every frame).
  // Also mark pinned nodes as `highlighted` so sigma renders them
  // with a subtle emphasis — the only discoverable cue that a node
  // is pinned and thus behaving differently from its neighbours.
  useEffect(() => {
    const apply = (): void => {
      const next: Record<string, { x: number; y: number }> = {};
      pinsMap.forEach((value, key) => {
        next[key] = value;
      });
      pinsRef.current = next;
      const g = graphRef.current;
      if (g) {
        g.forEachNode((id) => {
          g.setNodeAttribute(id, 'highlighted', next[id] != null);
        });
      }
    };
    apply();
    pinsMap.observe(apply);
    return () => pinsMap.unobserve(apply);
  }, [pinsMap]);

  // Soft anchors: mirror into a ref for the physics loop.
  useEffect(() => {
    const apply = (): void => {
      const next: Record<string, { x: number; y: number }> = {};
      anchorsMap.forEach((value, key) => {
        if (value && typeof value === 'object') next[key] = value;
      });
      anchorsRef.current = next;
    };
    apply();
    anchorsMap.observe(apply);
    return () => anchorsMap.unobserve(apply);
  }, [anchorsMap]);

  // Colours: shared via Y.Map. State holds a mirror that React
  // re-renders against so the palette UI + node-colour effect pick
  // up remote changes.
  useEffect(() => {
    const apply = (): void => {
      const next: Record<string, string> = {};
      coloursMap.forEach((value, key) => {
        next[key] = value;
      });
      setTagColors(next);
    };
    apply();
    coloursMap.observe(apply);
    return () => coloursMap.unobserve(apply);
  }, [coloursMap]);

  // Groups: same shape as colours — Y.Map keyed by group id, value is
  // the full Group record. Local array is ordered by insertion time
  // (createdAt field folded into the id) for stable render.
  useEffect(() => {
    const apply = (): void => {
      const next: Group[] = [];
      groupsMap.forEach((value) => {
        if (value && typeof value === 'object' && typeof value.id === 'string') {
          next.push(value);
        }
      });
      next.sort((a, b) => a.id.localeCompare(b.id));
      setGroups(next);
    };
    apply();
    groupsMap.observe(apply);
    return () => groupsMap.unobserve(apply);
  }, [groupsMap]);

  // ── main load + render cycle ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    setStatus('loading');
    setError(null);

    const waitForSync = (): Promise<void> =>
      new Promise((resolve) => {
        if (provider.synced) {
          resolve();
          return;
        }
        const onSynced = (): void => {
          provider.off('synced', onSynced);
          resolve();
        };
        provider.on('synced', onSynced);
        // Safety net: if the server takes too long, proceed with
        // whatever we have so the page isn't blocked forever.
        setTimeout(() => {
          provider.off('synced', onSynced);
          resolve();
        }, 2000);
      });

    (async () => {
      try {
        // Wait for the shared graph-state doc to finish its initial
        // sync BEFORE seeding node positions. Otherwise a second
        // connector would lay out random positions locally and only
        // snap to the shared pins after the first remote update.
        await waitForSync();
        if (cancelled) return;

        const res = await fetch(`/api/graph?scope=${encodeURIComponent(scopeParam)}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as GraphPayload;
        if (cancelled) return;

        sigmaRef.current?.kill();
        sigmaRef.current = null;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;

        setNodesPayload(payload.nodes);

        const g = new Graph({ multi: false, type: 'directed', allowSelfLoops: false });
        const pins = pinsRef.current;
        for (const n of payload.nodes) {
          const pin = pins[n.id];
          // Deterministic seed so every peer starts from the same
          // layout. Random seeding produced wildly different
          // burned-in graphs across connected users.
          const seed = seedPosition(n.id);
          g.addNode(n.id, {
            label: n.title,
            size: radiusForDegree(n.degree) * nodeScaleRef.current,
            color: colorFor(n.id, n.tags),
            x: pin?.x ?? seed.x,
            y: pin?.y ?? seed.y,
            tags: n.tags,
            degree: n.degree,
            highlighted: !!pin,
          });
        }
        for (const e of payload.edges) {
          if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
          const key = `${e.source}→${e.target}`;
          if (g.hasEdge(key)) continue;
          g.addEdgeWithKey(key, e.source, e.target, {
            size: 1,
            color: 'rgba(42, 36, 30, 0.4)',
          });
        }

        // Burn-in layout: a short synchronous pre-pass so the first
        // render isn't a tangled hairball before physics relaxes.
        if (g.order > 1) {
          const settings = forceAtlas2.inferSettings(g);
          forceAtlas2.assign(g, {
            iterations: Math.min(150, Math.max(30, Math.floor(300 / Math.max(1, Math.sqrt(g.order))))),
            settings: {
              ...settings,
              gravity: 0.3,
              scalingRatio: 10,
              slowDown: 5,
              barnesHutOptimize: g.order > 500,
            },
          });
        }

        const labelSettings = labelModeToSigmaSettings(labelMode);
        const renderer = new Sigma(g, container, {
          defaultNodeColor: '#5A4F42',
          defaultEdgeColor: 'rgba(42, 36, 30, 0.4)',
          labelColor: { color: '#2A241E' },
          labelWeight: '500',
          labelFont: 'Inter, system-ui, sans-serif',
          labelSize: 12,
          ...labelSettings,
        });

        sigmaRef.current = renderer;
        graphRef.current = g;
        setCounts({ nodes: g.order, edges: g.size });

        // Seed our awareness user info — the cursor overlay renders
        // each peer's name label from here. No CollaborationCaret on
        // the graph, so we set it manually.
        provider.awareness?.setLocalStateField('user', {
          userId: me.userId,
          name: me.displayName || 'Anonymous',
          color: me.accentColor,
          cursorMode: me.cursorMode,
          avatarVersion: me.avatarVersion,
        });

        // Broadcast the local cursor in GRAPH coordinates (not
        // screen px). That way peers can render the cursor at the
        // same spot in graph-space as the node being dragged — so a
        // drag's cursor visibly follows the moving node on every
        // connected user's screen, regardless of viewport size.
        const onContainerMove = (e: MouseEvent): void => {
          const rect = container.getBoundingClientRect();
          const viewport = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          const gp = renderer.viewportToGraph(viewport);
          provider.awareness?.setLocalStateField('graphPointer', {
            x: gp.x,
            y: gp.y,
          });
        };
        const onContainerLeave = (): void => {
          provider.awareness?.setLocalStateField('graphPointer', null);
        };
        container.addEventListener('mousemove', onContainerMove);
        container.addEventListener('mouseleave', onContainerLeave);

        // Observe remote awareness for graphPointer + user.
        const aw = provider.awareness;
        const onAwarenessChange = (): void => {
          if (!aw) return;
          const list: RemoteGraphCursor[] = [];
          for (const [clientId, state] of aw.getStates().entries()) {
            if (clientId === aw.clientID) continue;
            const s = state as
              | {
                  user?: {
                    userId?: string;
                    name?: string;
                    color?: string;
                    cursorMode?: 'color' | 'image';
                    avatarVersion?: number;
                  };
                  graphPointer?: { x: number; y: number } | null;
                }
              | undefined;
            if (!s?.user || !s.graphPointer) continue;
            const gp = s.graphPointer;
            if (typeof gp.x !== 'number' || typeof gp.y !== 'number') continue;
            list.push({
              clientId,
              userId: s.user.userId ?? '',
              name: s.user.name ?? 'Anonymous',
              color: s.user.color ?? '#5A4F42',
              cursorMode: s.user.cursorMode === 'image' ? 'image' : 'color',
              avatarVersion:
                typeof s.user.avatarVersion === 'number'
                  ? s.user.avatarVersion
                  : 0,
              gx: gp.x,
              gy: gp.y,
            });
          }
          setRemoteCursors(list);
        };
        aw?.on('change', onAwarenessChange);
        onAwarenessChange();

        // Re-render the cursor overlay on every sigma frame — camera
        // motion, drag, and physics all move the graph→viewport
        // projection, so peer cursor pixels need refreshing each
        // frame. This is the only React state update driven by the
        // renderer; the physics loop itself runs in rAF without
        // touching React.
        const onAfterRender = (): void => {
          setRenderTick((t) => (t + 1) & 0x3fffffff);
        };
        renderer.on('afterRender', onAfterRender);

        // Bundle these listeners into the outer cleanup so they
        // vanish with the renderer.
        const cleanupListeners = (): void => {
          container.removeEventListener('mousemove', onContainerMove);
          container.removeEventListener('mouseleave', onContainerLeave);
          aw?.off('change', onAwarenessChange);
          aw?.setLocalStateField('graphPointer', null);
          renderer.off('afterRender', onAfterRender);
        };
        cleanupListenersRef.current = cleanupListeners;

        // ── Continuous physics loop ──────────────────────────────────
        const liveSettings = forceAtlas2.inferSettings(g);
        const tickOpts = {
          iterations: 1,
          settings: {
            ...liveSettings,
            gravity: 1,
            scalingRatio: 10,
            slowDown: 20, // high slowdown = less jitter once settled
            barnesHutOptimize: g.order > 500,
          },
        };
        const tick = (): void => {
          if (!sigmaRef.current || cancelled) return;
          if (g.order > 1) {
            forceAtlas2.assign(g, tickOpts);
            // Soft anchors — after FA2 moves each anchored node this
            // tick, pull it a little back toward its drop position.
            // Low strength means the node still reacts to the rest
            // of the graph (physics keeps it "floaty") but it hovers
            // around the drop point instead of drifting back to
            // FA2's unconstrained equilibrium.
            const ANCHOR_STRENGTH = 0.06;
            for (const [id, anchor] of Object.entries(anchorsRef.current)) {
              if (!g.hasNode(id)) continue;
              // Hard pins win — skip anchor if the same node is
              // also pinned (shouldn't happen because pins replace
              // anchors on write, but be defensive).
              if (pinsRef.current[id]) continue;
              const x = g.getNodeAttribute(id, 'x') as number;
              const y = g.getNodeAttribute(id, 'y') as number;
              g.setNodeAttribute(
                id,
                'x',
                x + (anchor.x - x) * ANCHOR_STRENGTH,
              );
              g.setNodeAttribute(
                id,
                'y',
                y + (anchor.y - y) * ANCHOR_STRENGTH,
              );
            }
            // Hard pins — persistent, shared with peers. Applied
            // after anchors so they can't be softened by a lingering
            // anchor entry.
            for (const [id, pos] of Object.entries(pinsRef.current)) {
              if (g.hasNode(id)) {
                g.setNodeAttribute(id, 'x', pos.x);
                g.setNodeAttribute(id, 'y', pos.y);
              }
            }
            // Local drag in progress — hold the node at the cursor.
            const dragged = draggedRef.current;
            if (dragged && g.hasNode(dragged.node)) {
              g.setNodeAttribute(dragged.node, 'x', dragged.x);
              g.setNodeAttribute(dragged.node, 'y', dragged.y);
            }
            // Remote drags in progress — reflect each connected peer's
            // awareness.dragging into their target node so we see
            // moves in real time (the writer clears awareness on drop
            // so physics resumes there unless they shift-pinned).
            const aw = provider.awareness;
            if (aw) {
              for (const [clientId, state] of aw.getStates()) {
                if (clientId === aw.clientID) continue;
                const drag = (state as { dragging?: { node: string; x: number; y: number } } | undefined)?.dragging;
                if (drag && drag.node && g.hasNode(drag.node)) {
                  g.setNodeAttribute(drag.node, 'x', drag.x);
                  g.setNodeAttribute(drag.node, 'y', drag.y);
                }
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        // ── Interactions ─────────────────────────────────────────────
        // Disambiguate click vs drag by comparing the pointerdown
        // position against pointerup; only navigate when the user
        // barely moved.
        let downScreenPos: { x: number; y: number } | null = null;
        renderer.on('clickNode', ({ node, event }) => {
          // In link mode clicks don't navigate — they're handled by
          // downNode + mouseup instead.
          if (linkModeRef.current) {
            event?.preventSigmaDefault?.();
            return;
          }
          const ev = event?.original as MouseEvent | undefined;
          if (downScreenPos && ev) {
            const dx = ev.clientX - downScreenPos.x;
            const dy = ev.clientY - downScreenPos.y;
            if (Math.hypot(dx, dy) > 5) return;
          }
          router.push('/notes/' + node.split('/').map(encodeURIComponent).join('/'));
        });

        renderer.on('enterNode', ({ node }) => {
          hoveredNodeRef.current = node;
          // In link mode skip the neighbour-fade; just highlight the
          // hovered node as a potential target.
          if (linkModeRef.current) {
            renderer.setSetting('nodeReducer', (n, data) => {
              if (n === linkSourceRef.current)
                return { ...data, color: '#D4A85A', highlighted: true };
              if (n === node) return { ...data, color: '#8B4A52' };
              return data;
            });
            return;
          }
          const neighbours = new Set<string>(g.neighbors(node));
          neighbours.add(node);
          renderer.setSetting('nodeReducer', (n, data) => {
            if (!neighbours.has(n)) return { ...data, color: '#D4C7AE', label: '' };
            return data;
          });
          renderer.setSetting('edgeReducer', (_e, data) => {
            const [s, t] = g.extremities(_e);
            if (!neighbours.has(s) || !neighbours.has(t)) {
              return { ...data, color: 'rgba(42, 36, 30, 0.1)' };
            }
            return { ...data, color: '#D4A85A' };
          });
        });
        renderer.on('leaveNode', () => {
          hoveredNodeRef.current = null;
          renderer.setSetting('nodeReducer', null);
          renderer.setSetting('edgeReducer', null);
        });

        // Drag handling:
        //   * plain drag = move the node while held; physics resumes
        //     after release (node floats, doesn't pin).
        //   * shift-drag = same motion, but on release the final
        //     position is written to pinsMap so it stays put AND
        //     propagates to every peer.
        // During any drag we publish the live position via awareness
        // so peers see the motion in real time.
        let shiftHeld = false;
        const broadcastDrag = (): void => {
          const d = draggedRef.current;
          provider.awareness?.setLocalStateField(
            'dragging',
            d ? { node: d.node, x: d.x, y: d.y } : null,
          );
        };
        renderer.on('downNode', ({ node, event }) => {
          const ev = event?.original as MouseEvent | undefined;
          downScreenPos = ev ? { x: ev.clientX, y: ev.clientY } : null;

          if (linkModeRef.current) {
            // Start a rubber-band from this node.
            linkSourceRef.current = node;
            const attrs = g.getNodeAttributes(node) as { x: number; y: number };
            const vp = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
            setRubberBand({ from: vp, to: vp });
            event?.preventSigmaDefault?.();
            return;
          }

          shiftHeld = !!ev?.shiftKey;
          const { x, y } = g.getNodeAttributes(node) as { x: number; y: number };
          draggedRef.current = { node, x, y };
          broadcastDrag();
          event?.preventSigmaDefault?.();
        });

        const stage = renderer.getMouseCaptor();
        stage.on('mousemovebody', (e) => {
          if (linkModeRef.current) {
            const src = linkSourceRef.current;
            if (!src || !g.hasNode(src)) return;
            const attrs = g.getNodeAttributes(src) as { x: number; y: number };
            const fromVp = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
            setRubberBand({ from: fromVp, to: { x: e.x, y: e.y } });
            e.preventSigmaDefault();
            return;
          }

          const dragged = draggedRef.current;
          if (!dragged) return;
          const p = renderer.viewportToGraph({ x: e.x, y: e.y });
          dragged.x = p.x;
          dragged.y = p.y;
          broadcastDrag();
          e.preventSigmaDefault();
          e.original.preventDefault();
          e.original.stopPropagation();
        });

        stage.on('mouseup', (upEvent) => {
          if (linkModeRef.current) {
            const source = linkSourceRef.current;
            const target = hoveredNodeRef.current;
            linkSourceRef.current = null;
            setRubberBand(null);
            renderer.setSetting('nodeReducer', null);

            if (source && target && source !== target) {
              void fetch('/api/notes/backlink', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': csrfToken,
                },
                body: JSON.stringify({ fromPath: source, toPath: target }),
              }).then(() => {
                // Signal the graph to re-fetch edges.
                metaMap.set('graphDirty', Date.now());
              });
            }
            return;
          }

          const dragged = draggedRef.current;
          draggedRef.current = null;
          provider.awareness?.setLocalStateField('dragging', null);
          if (!dragged) return;
          // Click vs drag: only act on actual movement.
          const orig = upEvent.original;
          const clientX = 'clientX' in orig ? orig.clientX : undefined;
          const clientY = 'clientY' in orig ? orig.clientY : undefined;
          let moved = false;
          if (
            downScreenPos &&
            typeof clientX === 'number' &&
            typeof clientY === 'number'
          ) {
            const dx = clientX - downScreenPos.x;
            const dy = clientY - downScreenPos.y;
            moved = Math.hypot(dx, dy) > 5;
          }
          if (!moved) {
            shiftHeld = false;
            return;
          }
          if (shiftHeld) {
            pinsMap.set(dragged.node, { x: dragged.x, y: dragged.y });
            anchorsMap.delete(dragged.node);
          } else {
            anchorsMap.set(dragged.node, { x: dragged.x, y: dragged.y });
          }
          shiftHeld = false;
        });

        // Double-click a node to fully release it — clears both the
        // hard pin and any soft anchor, so it drifts back into the
        // flowing layout. Discoverable once a user has pinned or
        // dragged something.
        renderer.on('doubleClickNode', ({ node, event }) => {
          const hadPin = pinsMap.has(node);
          const hadAnchor = anchorsMap.has(node);
          if (!hadPin && !hadAnchor) return;
          if (hadPin) pinsMap.delete(node);
          if (hadAnchor) anchorsMap.delete(node);
          event?.preventSigmaDefault?.();
        });

        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load graph');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      sigmaRef.current?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [
    scopeParam,
    groupId,
    router,
    colorFor,
    labelMode,
    provider,
    pinsMap,
    anchorsMap,
    me.userId,
    me.displayName,
    me.accentColor,
    me.cursorMode,
    me.avatarVersion,
    graphVersion,
  ]);

  // Live re-colour when tag overrides change without rebuilding the
  // graph (keeps physics running; feels instant).
  useEffect(() => {
    const g = graphRef.current;
    const renderer = sigmaRef.current;
    if (!g || !renderer) return;
    g.forEachNode((id, attrs) => {
      const tags = (attrs.tags as string[] | undefined) ?? [];
      g.setNodeAttribute(id, 'color', colorFor(id, tags));
    });
  }, [tagColors, groups, colorFor]);

  // Apply label-mode changes to a live sigma without rebuilding.
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    const s = labelModeToSigmaSettings(labelMode);
    for (const [k, v] of Object.entries(s)) {
      renderer.setSetting(k as Parameters<typeof renderer.setSetting>[0], v as never);
    }
  }, [labelMode]);

  // Keep link-mode ref in sync with state so interaction handlers
  // (defined once inside the main effect) always read the latest value.
  useEffect(() => {
    linkModeRef.current = linkMode;
    if (!linkMode) {
      linkSourceRef.current = null;
      setRubberBand(null);
    }
  }, [linkMode]);

  // Apply node scale changes without rebuilding the graph.
  useEffect(() => {
    nodeScaleRef.current = nodeScale;
    const g = graphRef.current;
    if (!g) return;
    g.forEachNode((node) => {
      const degree = (g.getNodeAttribute(node, 'degree') as number) ?? 0;
      g.setNodeAttribute(node, 'size', radiusForDegree(degree) * nodeScale);
    });
  }, [nodeScale]);

  const zoomBy = useCallback((factor: number) => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    renderer.getCamera().animatedZoom({ factor, duration: 200 });
  }, []);

  const fit = useCallback(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    renderer.getCamera().animatedReset({ duration: 200 });
  }, []);

  const clearPins = useCallback(() => {
    pinsMap.clear();
    anchorsMap.clear();
  }, [pinsMap, anchorsMap]);

  const createGroup = useCallback(() => {
    // Seeded with a fresh timestamp-prefixed id so rows sort by
    // insertion order (older groups stay at the top) while still
    // being unique across peers.
    const id =
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const group: Group = {
      id,
      name: `Group ${groups.length + 1}`,
      color: '#8B4A52',
      tags: [],
      notes: [],
    };
    groupsMap.set(id, group);
  }, [groups.length, groupsMap]);

  // Tags surfaced in the palette panel: include every tag present on
  // at least one node in the current scope, even if unused by the
  // priority default, so the user can colour any tag they like.
  const paletteTags = useMemo(() => {
    const seen = new Set<string>();
    for (const n of nodesPayload) for (const t of n.tags) seen.add(t.toLowerCase());
    for (const t of allTags) seen.add(t.toLowerCase());
    return [...seen].sort();
  }, [nodesPayload, allTags]);

  return (
    <>
      <div
        ref={containerRef}
        id={GRAPH_SCOPE_ID}
        className="absolute inset-0 bg-[#F4EDE0]"
        style={linkMode ? { cursor: 'crosshair' } : undefined}
      />

      {/* Peer cursors in graph space. Each peer broadcasts their
          mouse in sigma's internal graph coordinates; we convert
          back to viewport pixels every frame, so a peer's cursor
          tracks exactly alongside the node they're dragging
          regardless of how either viewer is zoomed or panned. */}
      <GraphCursors sigmaRef={sigmaRef} remotes={remoteCursors} tick={renderTick} />

      {/* Rubber-band line drawn while dragging in link mode. */}
      {rubberBand && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: 7 }}
          width="100%"
          height="100%"
        >
          <defs>
            <marker
              id="rb-arrow"
              markerWidth="8"
              markerHeight="6"
              refX="7"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill="#8B4A52" />
            </marker>
          </defs>
          <line
            x1={rubberBand.from.x}
            y1={rubberBand.from.y}
            x2={rubberBand.to.x}
            y2={rubberBand.to.y}
            stroke="#8B4A52"
            strokeWidth={2}
            strokeDasharray="7 4"
            strokeLinecap="round"
            markerEnd="url(#rb-arrow)"
          />
        </svg>
      )}

      <div className="pointer-events-none absolute left-4 top-4 w-64 space-y-2 text-sm">
        <div className="pointer-events-auto rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] p-3 shadow-[0_6px_18px_rgba(42,36,30,0.08)]">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
            Scope
          </label>
          <select
            value={scope.kind === 'tag' ? `tag:${scope.tag}` : 'all'}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'all') setScope({ kind: 'all' });
              else if (v.startsWith('tag:')) setScope({ kind: 'tag', tag: v.slice(4) });
            }}
            className="w-full rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
          >
            <option value="all">All notes</option>
            {allTags.length > 0 && (
              <optgroup label="By tag">
                {allTags.map((t) => (
                  <option key={t} value={`tag:${t}`}>
                    #{t}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="pointer-events-auto rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] p-3 shadow-[0_6px_18px_rgba(42,36,30,0.08)]">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
              Labels
            </span>
            <span className="text-xs text-[#5A4F42]">{labelModeLabel(labelMode)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={1}
            value={labelMode === 'none' ? 0 : labelMode === 'some' ? 1 : 2}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLabelMode(v === 0 ? 'none' : v === 1 ? 'some' : 'all');
            }}
            className="w-full accent-[#8B4A52]"
          />
        </div>

        <div className="pointer-events-auto rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] p-3 shadow-[0_6px_18px_rgba(42,36,30,0.08)]">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
              Node size
            </span>
            <span className="text-xs text-[#5A4F42]">{nodeScale.toFixed(1)}×</span>
          </div>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.1}
            value={nodeScale}
            onChange={(e) => setNodeScale(Number(e.target.value))}
            className="w-full accent-[#8B4A52]"
          />
        </div>

        <div className="pointer-events-auto flex items-center gap-1 rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] p-1 shadow-[0_6px_18px_rgba(42,36,30,0.08)]">
          <ToolButton onClick={() => zoomBy(1 / 1.4)} label="−" title="Zoom in" />
          <ToolButton onClick={() => zoomBy(1.4)} label="＋" title="Zoom out" />
          <ToolButton onClick={fit} label="Fit" title="Recentre" />
          <ToolButton onClick={clearPins} label="Unpin" title="Clear all pins" />
          <ToolButton
            onClick={() => setPalette((p) => !p)}
            label={palette ? 'Hide' : 'Colours'}
            title="Tag colour overrides"
          />
          <ToolButton
            onClick={() => setLinkMode((m) => !m)}
            label="Link"
            title={linkMode ? 'Exit link mode (drag between nodes to connect)' : 'Link mode — drag from one node to another to connect them'}
            active={linkMode}
          />
        </div>

        {palette && (
          <div className="pointer-events-auto max-h-64 overflow-y-auto rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] p-3 shadow-[0_6px_18px_rgba(42,36,30,0.08)]">
            <div className="mb-2 text-xs text-[#5A4F42]">
              Override the colour for any tag. Reset to default by clicking ⟲.
            </div>
            {paletteTags.length === 0 ? (
              <div className="text-xs text-[#5A4F42]">No tags yet.</div>
            ) : (
              <ul className="space-y-1">
                {paletteTags.map((t) => {
                  const current = tagColors[t] ?? colorForTags([t]);
                  const isOverride = t in tagColors;
                  return (
                    <li key={t} className="flex items-center gap-2">
                      <input
                        type="color"
                        value={current}
                        onChange={(e) => coloursMap.set(t, e.target.value)}
                        className="h-6 w-6 cursor-pointer rounded-[4px] border border-[#D4C7AE] bg-transparent p-0"
                      />
                      <span className="flex-1 truncate text-xs text-[#2A241E]">#{t}</span>
                      {isOverride && (
                        <button
                          type="button"
                          onClick={() => coloursMap.delete(t)}
                          title="Reset"
                          aria-label={`Reset colour for #${t}`}
                          className="rounded-[4px] px-1 text-xs text-[#5A4F42] transition hover:bg-[#2A241E]/10 hover:text-[#2A241E]"
                        >
                          ⟲
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {palette && (
          <div className="pointer-events-auto max-h-72 overflow-y-auto rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] p-3 shadow-[0_6px_18px_rgba(42,36,30,0.08)]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
                Groups
              </span>
              <button
                type="button"
                onClick={createGroup}
                className="rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-0.5 text-xs text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E]"
              >
                + New
              </button>
            </div>
            {groups.length === 0 ? (
              <div className="text-xs text-[#5A4F42]">
                Create a group to paint multiple tags or specific notes the
                same colour.
              </div>
            ) : (
              <ul className="space-y-2">
                {groups.map((g) => (
                  <GroupEditor
                    key={g.id}
                    group={g}
                    paletteTags={paletteTags}
                    onUpdate={(next) => groupsMap.set(g.id, next)}
                    onDelete={() => groupsMap.delete(g.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="pointer-events-none text-xs text-[#5A4F42]">
          {status === 'loading' && 'Loading graph…'}
          {status === 'ready' && !linkMode && (
            <>
              {counts.nodes} node{counts.nodes === 1 ? '' : 's'} ·{' '}
              {counts.edges} edge{counts.edges === 1 ? '' : 's'} · drag to
              anchor · shift-drag to pin · double-click to release
            </>
          )}
          {status === 'ready' && linkMode && (
            <span className="font-medium text-[#8B4A52]">
              Link mode — drag from one node to another to connect them
            </span>
          )}
          {status === 'error' && <span className="text-[#8B4A52]">Error: {error}</span>}
        </div>
      </div>
    </>
  );
}

function GroupEditor({
  group,
  paletteTags,
  onUpdate,
  onDelete,
}: {
  group: Group;
  paletteTags: string[];
  onUpdate: (next: Group) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [notePickerAnchor, setNotePickerAnchor] = useState<
    { left: number; top: number } | null
  >(null);
  const addNoteBtnRef = useRef<HTMLButtonElement>(null);

  const addNote = (path: string): void => {
    if (group.notes.includes(path)) return;
    onUpdate({ ...group, notes: [...group.notes, path] });
  };
  const removeNote = (path: string): void => {
    onUpdate({ ...group, notes: group.notes.filter((p) => p !== path) });
  };
  const addTag = (tag: string): void => {
    const lc = tag.toLowerCase();
    if (group.tags.map((t) => t.toLowerCase()).includes(lc)) return;
    onUpdate({ ...group, tags: [...group.tags, lc] });
  };
  const removeTag = (tag: string): void => {
    onUpdate({
      ...group,
      tags: group.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()),
    });
  };

  const availableTags = paletteTags.filter(
    (t) => !group.tags.map((x) => x.toLowerCase()).includes(t.toLowerCase()),
  );

  return (
    <li className="rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] p-2">
      <div className="mb-1 flex items-center gap-2">
        <input
          type="color"
          value={group.color}
          onChange={(e) => onUpdate({ ...group, color: e.target.value })}
          className="h-6 w-6 shrink-0 cursor-pointer rounded-[4px] border border-[#D4C7AE] bg-transparent p-0"
        />
        <input
          type="text"
          value={group.name}
          onChange={(e) => onUpdate({ ...group, name: e.target.value })}
          placeholder="Group name"
          className="min-w-0 flex-1 rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] px-1.5 py-0.5 text-xs text-[#2A241E] outline-none focus:border-[#D4A85A]"
        />
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete group "${group.name || 'Unnamed'}"?`)) onDelete();
          }}
          title="Delete group"
          aria-label={`Delete group ${group.name}`}
          className="rounded-[4px] px-1 text-xs text-[#8B4A52] transition hover:bg-[#8B4A52]/10"
        >
          ×
        </button>
      </div>

      {/* Tags row */}
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {group.tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full border border-[#D4C7AE] bg-[#FBF5E8] px-2 text-[10px] text-[#2A241E]"
          >
            #{t}
            <button
              type="button"
              onClick={() => removeTag(t)}
              aria-label={`Remove tag ${t}`}
              className="text-[#5A4F42] hover:text-[#8B4A52]"
            >
              ×
            </button>
          </span>
        ))}
        {availableTags.length > 0 && (
          <select
            onChange={(e) => {
              if (e.target.value) {
                addTag(e.target.value);
                e.target.value = '';
              }
            }}
            defaultValue=""
            className="rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] px-1 py-0.5 text-[10px] text-[#5A4F42]"
          >
            <option value="">+ tag</option>
            {availableTags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Notes row */}
      <div className="flex flex-wrap items-center gap-1">
        {group.notes.map((p) => {
          const label = p.split('/').pop()?.replace(/\.(md|canvas)$/i, '') ?? p;
          return (
            <span
              key={p}
              title={p}
              className="inline-flex items-center gap-1 rounded-full border border-[#D4C7AE] bg-[#FBF5E8] px-2 text-[10px] text-[#2A241E]"
            >
              {label}
              <button
                type="button"
                onClick={() => removeNote(p)}
                aria-label={`Remove note ${label}`}
                className="text-[#5A4F42] hover:text-[#8B4A52]"
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          ref={addNoteBtnRef}
          type="button"
          onClick={() => {
            const rect = addNoteBtnRef.current?.getBoundingClientRect();
            if (!rect) return;
            setNotePickerAnchor({ left: rect.right + 6, top: rect.top });
          }}
          className="rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] px-1.5 py-0.5 text-[10px] text-[#5A4F42] transition hover:bg-[#EAE1CF]"
        >
          + note
        </button>
      </div>

      {notePickerAnchor && (
        <NotePicker
          anchor={notePickerAnchor}
          onSelect={(p) => {
            addNote(p);
            setNotePickerAnchor(null);
          }}
          onClose={() => setNotePickerAnchor(null)}
        />
      )}
    </li>
  );
}

function ToolButton({
  label,
  title,
  onClick,
  active = false,
}: {
  label: string;
  title: string;
  onClick: () => void;
  active?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={
        'rounded-[6px] px-2 py-1 text-xs font-medium transition ' +
        (active
          ? 'bg-[#8B4A52]/15 text-[#8B4A52] hover:bg-[#8B4A52]/25'
          : 'text-[#5A4F42] hover:bg-[#D4A85A]/15 hover:text-[#2A241E]')
      }
    >
      {label}
    </button>
  );
}

function labelModeToSigmaSettings(mode: LabelMode): Record<string, unknown> {
  if (mode === 'none') {
    return { renderLabels: false };
  }
  if (mode === 'all') {
    return {
      renderLabels: true,
      labelDensity: 100,
      labelGridCellSize: 10,
      labelRenderedSizeThreshold: 0,
    };
  }
  return {
    renderLabels: true,
    labelDensity: 0.7,
    labelGridCellSize: 60,
    labelRenderedSizeThreshold: 6,
  };
}

function labelModeLabel(mode: LabelMode): string {
  if (mode === 'none') return 'None';
  if (mode === 'all') return 'All';
  return 'Some';
}

function GraphCursors({
  sigmaRef,
  remotes,
  tick,
}: {
  sigmaRef: React.RefObject<Sigma | null>;
  remotes: RemoteGraphCursor[];
  tick: number;
}): React.JSX.Element {
  void tick; // ensures the div re-renders every sigma frame
  const renderer = sigmaRef.current;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 6 }}
    >
      {renderer
        ? remotes.map((r) => {
            const vp = renderer.graphToViewport({ x: r.gx, y: r.gy });
            const avatarUrl =
              r.cursorMode === 'image' && r.avatarVersion > 0 && r.userId
                ? `/api/users/${r.userId}/avatar?v=${r.avatarVersion}`
                : null;
            return (
              <div
                key={r.clientId}
                className="absolute flex items-start"
                style={{ left: vp.x, top: vp.y, color: r.color }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill={r.color}
                  stroke="#FBF5E8"
                  strokeWidth="1"
                >
                  <path d="M1 1 L1 11 L4 8 L6.5 13 L8.5 12.2 L6 7.3 L11 7.3 Z" />
                </svg>
                <div className="flex flex-col items-center">
                  {avatarUrl && (
                    <img
                      src={avatarUrl}
                      alt=""
                      className="h-10 w-10 rounded-full border-2 object-cover shadow-[0_2px_6px_rgba(42,36,30,0.3)]"
                      style={{ borderColor: r.color }}
                    />
                  )}
                  <span
                    className="whitespace-nowrap rounded-[4px] px-1 text-[10px] font-medium text-[#2A241E]"
                    style={{ backgroundColor: r.color }}
                  >
                    {r.name}
                  </span>
                </div>
              </div>
            );
          })
        : null}
    </div>
  );
}

// Deterministic per-node seed. Maps a node id to a point in roughly
// [-1, 1] × [-1, 1] via a simple string hash. Two peers hashing the
// same id land on identical coordinates, so the burned-in layout
// matches on both sides. The quality isn't cryptographic — just
// enough to spread the initial cloud so forceatlas2 has useful
// gradients to work with.
function seedPosition(id: string): { x: number; y: number } {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  const fx = (h1 & 0xffff) / 0xffff; // [0, 1]
  const fy = (h2 & 0xffff) / 0xffff;
  return { x: fx * 2 - 1, y: fy * 2 - 1 };
}

function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}
