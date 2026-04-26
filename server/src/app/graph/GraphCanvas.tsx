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
import { Menu, X } from 'lucide-react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { clusterSeedPositions, colorForTags, radiusForDegree } from './graphStyle';
import { NotePicker } from '../notes/NotePicker';

// Sigma's WebGL renderer can't read CSS variables, so we snapshot the
// matching `--<name>-rgb` triplet at render time and rebuild `rgba()`
// strings from it. SSR (no `document`) returns the day value.
const PALETTE_FALLBACKS: Record<string, [number, number, number]> = {
  ink: [42, 36, 30],
  'ink-soft': [90, 79, 66],
  parchment: [244, 237, 224],
  wine: [139, 74, 82],
  candlelight: [212, 168, 90],
  moss: [123, 138, 95],
  sage: [107, 127, 142],
  embers: [181, 87, 42],
  rule: [212, 199, 174],
};
function paletteRgba(name: keyof typeof PALETTE_FALLBACKS, alpha = 1): string {
  const fallback = PALETTE_FALLBACKS[name] ?? [42, 36, 30];
  let triplet: [number, number, number] = fallback;
  if (typeof document !== 'undefined') {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(`--${name}-rgb`)
      .trim();
    const parts = raw ? raw.split(/\s+/).map(Number) : [];
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      triplet = [parts[0]!, parts[1]!, parts[2]!];
    }
  }
  const [r, g, b] = triplet;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function inkRgba(alpha: number): string {
  return paletteRgba('ink', alpha);
}

// Resolve any colour token Sigma might receive into something its WebGL
// parser actually understands (rgba/hex). Accepts: bare palette names
// (`'wine'`), `var(--name)` strings, `rgb(var(--name-rgb) / 0.1)` strings,
// and pass-through hex/rgba.
function resolveSigmaColor(token: string): string {
  const t = token.trim();
  if (t.startsWith('#') || t.startsWith('rgba(') || (t.startsWith('rgb(') && !t.includes('var('))) {
    return t;
  }
  const varMatch = t.match(/^var\(--([a-z-]+?)(?:-rgb)?\)$/);
  if (varMatch?.[1] && varMatch[1] in PALETTE_FALLBACKS) {
    return paletteRgba(varMatch[1] as keyof typeof PALETTE_FALLBACKS);
  }
  // `rgb(var(--name-rgb) / 0.1)` — resolve to the named palette at the
  // given alpha.
  const tintMatch = t.match(/^rgba?\(\s*var\(--([a-z-]+?)-rgb\)\s*\/\s*([0-9.]+)\s*\)$/);
  if (tintMatch?.[1] && tintMatch[2] && tintMatch[1] in PALETTE_FALLBACKS) {
    return paletteRgba(tintMatch[1] as keyof typeof PALETTE_FALLBACKS, Number(tintMatch[2]));
  }
  if (t in PALETTE_FALLBACKS) {
    return paletteRgba(t as keyof typeof PALETTE_FALLBACKS);
  }
  return t;
}

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
// Exported so the 3D graph view can reuse the same shape and Yjs map
// (`graph-groups:<groupId>`). Editing in either view updates the shared
// CRDT and broadcasts to peers.
export type Group = {
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
  // Tracks edge-loading progress for the progressive build:
  //   - total = number of edges the server reported in the edges-phase fetch
  //   - loaded = number actually inserted into the graph so far
  // Both 0 means "no edge load in flight". loaded === total > 0 means done.
  const [edgeProgress, setEdgeProgress] = useState<{ loaded: number; total: number }>(
    { loaded: 0, total: 0 },
  );
  const [labelMode, setLabelMode] = useState<LabelMode>('some');
  const [tagColors, setTagColors] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [nodesPayload, setNodesPayload] = useState<GraphPayload['nodes']>([]);
  const [remoteCursors, setRemoteCursors] = useState<RemoteGraphCursor[]>([]);
  // Bumped on every sigma render so the overlay rerenders the peer
  // cursors at their latest screen positions (camera pan/zoom,
  // dragged nodes, physics — all update the graph→viewport mapping).
  const [renderTick, setRenderTick] = useState<number>(0);
  // nodeScale, gravity, repulsion, and clusterSpacing are persisted in metaMap
  // so all peers share the same values; the observer below keeps local state in sync.
  const [nodeScale, setNodeScale] = useState<number>(1);
  const nodeScaleRef = useRef<number>(1);
  const [gravity, setGravity] = useState<number>(1);
  const gravityRef = useRef<number>(1);
  const [repulsion, setRepulsion] = useState<number>(10);
  const repulsionRef = useRef<number>(10);
  // clusterSpacing triggers a graph rebuild (in effect deps); pendingSpacing
  // tracks the slider display without triggering a rebuild on every drag tick.
  const [clusterSpacing, setClusterSpacing] = useState<number>(7);
  const [pendingSpacing, setPendingSpacing] = useState<number>(7);
  const [labelOpacity, setLabelOpacity] = useState<number>(1);
  const labelOpacityRef = useRef<number>(1);
  const [edgeOpacity, setEdgeOpacity] = useState<number>(0.4);
  const edgeOpacityRef = useRef<number>(0.4);

  // Collapsible menu sections — all open by default except physics/colours/groups.
  const [sectLabels, setSectLabels] = useState(true);
  const [sectNodes, setSectNodes] = useState(true);
  const [sectPhysics, setSectPhysics] = useState(false);
  const [sectColours, setSectColours] = useState(false);
  const [sectGroups, setSectGroups] = useState(false);

  // Link-draw mode: toggle button switches between pan/drag and
  // rubber-band link creation. Refs keep the interaction handlers
  // (defined once in the main effect) up-to-date without re-running.
  const [menuOpen, setMenuOpen] = useState<boolean>(true);
  const [linkMode, setLinkMode] = useState<boolean>(false);
  const linkModeRef = useRef<boolean>(false);
  const linkSourceRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const [rubberBand, setRubberBand] = useState<{
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);

  // colorForRef lets the main load effect use the latest colorFor without
  // subscribing to it — groups/tagColors syncing during initial load was
  // causing the effect to cancel and restart in a loop, keeping the graph
  // stuck in "loading" indefinitely on active campaigns.
  const colorForRef = useRef<((nodeId: string, tags: readonly string[]) => string) | null>(null);

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

  // addNewEdges + its observer are defined after scopeParam (below).

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

  // When the server signals note_links changed, add only NEW edges to
  // the live graph without rebuilding Sigma (avoids the flash/reset).
  const addNewEdges = useCallback(async (): Promise<void> => {
    const g = graphRef.current;
    if (!g) return;
    try {
      const res = await fetch(`/api/graph?scope=${encodeURIComponent(scopeParam)}`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const payload = (await res.json()) as GraphPayload;
      let changed = false;
      const affectedNodes = new Set<string>();
      for (const e of payload.edges) {
        if (e.source === e.target) continue; // graph forbids self-loops
        if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
        const key = `${e.source}→${e.target}`;
        if (!g.hasEdge(key)) {
          g.addEdgeWithKey(key, e.source, e.target, {
            size: 1,
            color: paletteRgba('ink-soft', edgeOpacityRef.current),
          });
          affectedNodes.add(e.source);
          affectedNodes.add(e.target);
          changed = true;
        }
      }
      if (changed) {
        for (const id of affectedNodes) {
          const d = g.degree(id);
          g.setNodeAttribute(id, 'degree', d);
          g.setNodeAttribute(id, 'size', radiusForDegree(d) * nodeScaleRef.current);
        }
        setCounts({ nodes: g.order, edges: g.size });
      }
    } catch {
      /* ignore — stale graph is better than a crash */
    }
  }, [scopeParam]);

  useEffect(() => {
    // Seed local values from whatever a peer already set.
    const stored = metaMap.get('nodeScale');
    if (typeof stored === 'number' && stored > 0) setNodeScale(stored);
    const storedGravity = metaMap.get('gravity');
    if (typeof storedGravity === 'number' && storedGravity > 0) setGravity(storedGravity);
    const storedRepulsion = metaMap.get('repulsion');
    if (typeof storedRepulsion === 'number' && storedRepulsion > 0) setRepulsion(storedRepulsion);
    const storedSpacing = metaMap.get('clusterSpacing');
    if (typeof storedSpacing === 'number' && storedSpacing > 0) {
      setClusterSpacing(storedSpacing);
      setPendingSpacing(storedSpacing);
    }
    const storedLabelOpacity = metaMap.get('labelOpacity');
    if (typeof storedLabelOpacity === 'number') setLabelOpacity(storedLabelOpacity);
    const storedEdgeOpacity = metaMap.get('edgeOpacity');
    if (typeof storedEdgeOpacity === 'number') setEdgeOpacity(storedEdgeOpacity);

    const onMeta = (): void => {
      if (metaMap.has('graphDirty')) void addNewEdges();
      const v = metaMap.get('nodeScale');
      if (typeof v === 'number' && v > 0) setNodeScale(v);
      const g = metaMap.get('gravity');
      if (typeof g === 'number' && g > 0) setGravity(g);
      const r = metaMap.get('repulsion');
      if (typeof r === 'number' && r > 0) setRepulsion(r);
      const s = metaMap.get('clusterSpacing');
      if (typeof s === 'number' && s > 0) { setClusterSpacing(s); setPendingSpacing(s); }
      const lo = metaMap.get('labelOpacity');
      if (typeof lo === 'number') setLabelOpacity(lo);
      const eo = metaMap.get('edgeOpacity');
      if (typeof eo === 'number') setEdgeOpacity(eo);
    };
    metaMap.observe(onMeta);
    return () => metaMap.unobserve(onMeta);
  }, [metaMap, addNewEdges]);

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
        if (g.notes.includes(nodeId)) return resolveSigmaColor(g.color);
        for (const t of g.tags) {
          if (lower.includes(t.toLowerCase())) return resolveSigmaColor(g.color);
        }
      }
      for (const t of tags) {
        const override = tagColors[t.toLowerCase()];
        if (override) return resolveSigmaColor(override);
      }
      return resolveSigmaColor(colorForTags(tags));
    },
    [groups, tagColors],
  );
  useEffect(() => { colorForRef.current = colorFor; });

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

        // Phase 1 — fetch nodes only. The API skips the edge join so
        // this lands in a single SELECT. We can render the node skeleton
        // and unblock the user before any edge work begins.
        const nodesRes = await fetch(
          `/api/graph?scope=${encodeURIComponent(scopeParam)}&phase=nodes`,
          { cache: 'no-store' },
        );
        if (!nodesRes.ok) throw new Error(`HTTP ${nodesRes.status}`);
        const nodesBody = (await nodesRes.json()) as Pick<GraphPayload, 'nodes'>;
        if (cancelled) return;

        sigmaRef.current?.kill();
        sigmaRef.current = null;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;

        setNodesPayload(nodesBody.nodes);
        // Reset progress so the bar shows 0% as edges start streaming in.
        setEdgeProgress({ loaded: 0, total: 0 });

        const g = new Graph({ multi: false, type: 'directed', allowSelfLoops: false });
        // Cluster-aware seed: nodes in the same campaign folder start near
        // each other so FA2 refines existing groups rather than discovering
        // them from a random scatter. Fully deterministic — same positions
        // on every peer for the same node list.
        const seedPositions = clusterSeedPositions(nodesBody.nodes, clusterSpacing);
        const pins = pinsRef.current;
        for (const n of nodesBody.nodes) {
          const pin = pins[n.id];
          const seed = seedPositions.get(n.id) ?? { x: 0, y: 0 };
          g.addNode(n.id, {
            label: n.title,
            size: radiusForDegree(n.degree) * nodeScaleRef.current,
            color: (colorForRef.current ?? colorFor)(n.id, n.tags),
            labelColor: inkRgba(labelOpacityRef.current),
            x: pin?.x ?? seed.x,
            y: pin?.y ?? seed.y,
            tags: n.tags,
            degree: n.degree,
            highlighted: !!pin,
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
          defaultNodeColor: paletteRgba('ink-soft'),
          defaultEdgeColor: paletteRgba('ink-soft', edgeOpacityRef.current),
          labelColor: { attribute: 'labelColor' },
          labelWeight: '500',
          labelFont: 'Inter, system-ui, sans-serif',
          labelSize: 12,
          ...labelSettings,
        });

        sigmaRef.current = renderer;
        graphRef.current = g;
        setCounts({ nodes: g.order, edges: g.size });

        // Phase 2 — fetch edges and stream them in. Done in a separate
        // round-trip so the node skeleton is interactable immediately
        // while the link mesh fills in. Inserted in 50-edge batches via
        // requestAnimationFrame so the FA2 physics loop doesn't stall
        // on a single huge insert. Updates `edgeProgress` so the status
        // bar can render a fill percentage.
        void (async () => {
          try {
            const edgesRes = await fetch(
              `/api/graph?scope=${encodeURIComponent(scopeParam)}&phase=edges`,
              { cache: 'no-store' },
            );
            if (!edgesRes.ok) throw new Error(`HTTP ${edgesRes.status}`);
            const edgesBody = (await edgesRes.json()) as Pick<GraphPayload, 'edges'>;
            if (cancelled) return;
            const allEdges = edgesBody.edges;
            // Pre-filter to valid in-graph edges so the progress bar
            // measures real work, not skipped rows.
            const valid = allEdges.filter(
              (e) =>
                e.source !== e.target &&
                g.hasNode(e.source) &&
                g.hasNode(e.target),
            );
            setEdgeProgress({ loaded: 0, total: valid.length });
            if (valid.length === 0) return;

            const BATCH = 50;
            let i = 0;
            const drainBatch = (): void => {
              if (cancelled || !sigmaRef.current) return;
              const end = Math.min(i + BATCH, valid.length);
              const touched = new Set<string>();
              for (; i < end; i++) {
                const e = valid[i]!;
                const key = `${e.source}→${e.target}`;
                if (g.hasEdge(key)) continue;
                g.addEdgeWithKey(key, e.source, e.target, {
                  size: 1,
                  color: paletteRgba('ink-soft', edgeOpacityRef.current),
                });
                touched.add(e.source);
                touched.add(e.target);
              }
              // Recompute degree-derived size on the touched subset only —
              // Graphology's degree() is O(1) so this stays cheap per batch.
              for (const id of touched) {
                const d = g.degree(id);
                g.setNodeAttribute(id, 'degree', d);
                g.setNodeAttribute(
                  id,
                  'size',
                  radiusForDegree(d) * nodeScaleRef.current,
                );
              }
              setEdgeProgress({ loaded: i, total: valid.length });
              setCounts({ nodes: g.order, edges: g.size });
              if (i < valid.length) {
                requestAnimationFrame(drainBatch);
              }
            };
            requestAnimationFrame(drainBatch);
          } catch {
            /* ignore — node skeleton stays interactive without edges */
          }
        })();

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
              color: s.user.color ?? 'var(--ink-soft)',
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
        // gravity and scalingRatio are read from refs each frame so the
        // Physics sliders take effect immediately without a graph rebuild.
        const liveSettings = forceAtlas2.inferSettings(g);
        const tickOpts = {
          iterations: 1,
          settings: {
            ...liveSettings,
            gravity: gravityRef.current,
            scalingRatio: repulsionRef.current,
            slowDown: 20, // high slowdown = less jitter once settled
            barnesHutOptimize: g.order > 500,
          },
        };
        const tick = (): void => {
          if (!sigmaRef.current || cancelled) return;
          if (g.order > 1) {
            tickOpts.settings.gravity = gravityRef.current;
            tickOpts.settings.scalingRatio = repulsionRef.current;
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
                return { ...data, color: paletteRgba('candlelight'), highlighted: true };
              if (n === node) return { ...data, color: paletteRgba('wine') };
              return data;
            });
            return;
          }
          const neighbours = new Set<string>(g.neighbors(node));
          neighbours.add(node);
          renderer.setSetting('nodeReducer', (n, data) => {
            if (!neighbours.has(n)) return { ...data, color: paletteRgba('rule'), label: '' };
            return data;
          });
          renderer.setSetting('edgeReducer', (_e, data) => {
            const [s, t] = g.extremities(_e);
            if (!neighbours.has(s) || !neighbours.has(t)) {
              return { ...data, color: paletteRgba('ink', 0.1) };
            }
            return { ...data, color: paletteRgba('candlelight') };
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
              // Add the edge immediately to the live graph for instant
              // feedback — no Sigma rebuild, no flash.
              const key = `${source}→${target}`;
              if (g.hasNode(source) && g.hasNode(target) && !g.hasEdge(key)) {
                g.addEdgeWithKey(key, source, target, {
                  size: 1,
                  color: paletteRgba('ink-soft', edgeOpacityRef.current),
                });
                for (const id of [source, target]) {
                  const d = g.degree(id);
                  g.setNodeAttribute(id, 'degree', d);
                  g.setNodeAttribute(id, 'size', radiusForDegree(d) * nodeScaleRef.current);
                }
                setCounts({ nodes: g.order, edges: g.size });
              }
              // Persist to DB then signal remote peers to pull the new edge.
              void fetch('/api/notes/backlink', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': csrfToken,
                },
                body: JSON.stringify({ fromPath: source, toPath: target }),
              }).then(() => {
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
    labelMode,
    provider,
    pinsMap,
    anchorsMap,
    me.userId,
    me.displayName,
    me.accentColor,
    me.cursorMode,
    me.avatarVersion,
    clusterSpacing,
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
      g.setNodeAttribute(node, 'size', radiusForDegree(g.degree(node)) * nodeScale);
    });
  }, [nodeScale]);

  // Keep physics refs in sync so the RAF tick reads current slider values.
  useEffect(() => { gravityRef.current = gravity; }, [gravity]);
  useEffect(() => { repulsionRef.current = repulsion; }, [repulsion]);

  // Apply label opacity to all nodes without rebuilding the graph.
  useEffect(() => {
    labelOpacityRef.current = labelOpacity;
    const g = graphRef.current;
    if (!g) return;
    const color = inkRgba(labelOpacity);
    g.forEachNode((node) => g.setNodeAttribute(node, 'labelColor', color));
  }, [labelOpacity]);

  // Apply edge opacity to all edges without rebuilding the graph.
  useEffect(() => {
    edgeOpacityRef.current = edgeOpacity;
    const g = graphRef.current;
    if (!g) return;
    const color = paletteRgba('ink-soft', edgeOpacity);
    g.forEachEdge((edge) => g.setEdgeAttribute(edge, 'color', color));
  }, [edgeOpacity]);

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
      color: paletteRgba('wine'),
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
        className="absolute inset-0 bg-[var(--parchment)]"
        style={linkMode ? { cursor: 'crosshair' } : undefined}
      />

      <GraphLoadingOverlay
        status={status}
        error={error}
        counts={counts}
        edgeProgress={edgeProgress}
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
              <polygon points="0 0, 8 3, 0 6" fill="var(--wine)" />
            </marker>
          </defs>
          <line
            x1={rubberBand.from.x}
            y1={rubberBand.from.y}
            x2={rubberBand.to.x}
            y2={rubberBand.to.y}
            stroke="var(--wine)"
            strokeWidth={2}
            strokeDasharray="7 4"
            strokeLinecap="round"
            markerEnd="url(#rb-arrow)"
          />
        </svg>
      )}

      {/* ── Roam / Weave mode toggle — top centre ──────────────────── */}
      <div
        className="pointer-events-auto absolute left-1/2 top-4 -translate-x-1/2"
        style={{ zIndex: 8 }}
      >
        <button
          type="button"
          role="switch"
          aria-checked={linkMode}
          onClick={() => setLinkMode((m) => !m)}
          title={linkMode ? 'Weave mode — drag between nodes to forge a link' : 'Roam mode — drag to explore'}
          className="relative flex h-11 w-60 select-none items-center rounded-full border border-[var(--rule)] bg-[var(--vellum)] p-1 shadow-[0_4px_14px_rgb(var(--ink-rgb) / 0.14)] transition-shadow hover:shadow-[0_6px_18px_rgb(var(--ink-rgb) / 0.18)]"
        >
          {/* Sliding pill */}
          <span
            aria-hidden
            className={[
              'absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-full transition-all duration-200',
              linkMode ? 'left-[calc(50%+0px)] bg-[var(--wine)]' : 'left-1 bg-[var(--candlelight)]',
            ].join(' ')}
          />
          <span
            className={[
              'relative z-10 flex flex-1 items-center justify-center gap-1.5 transition-colors',
              !linkMode ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]/70',
            ].join(' ')}
          >
            <span className="text-2xl leading-none">⚔</span>
            <span className="text-sm font-semibold">Roam</span>
          </span>
          <span
            className={[
              'relative z-10 flex flex-1 items-center justify-center gap-1.5 transition-colors',
              linkMode ? 'text-white' : 'text-[var(--ink-soft)]/70',
            ].join(' ')}
          >
            <span className="text-2xl leading-none">✦</span>
            <span className="text-sm font-semibold">Weave</span>
          </span>
        </button>
      </div>

      {/* ── Left control panel ─────────────────────────────────────── */}
      <div className="pointer-events-none absolute left-4 top-4 flex flex-col gap-2 text-sm">
        {/* Burger — always visible */}
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          title={menuOpen ? 'Hide controls' : 'Show controls'}
          aria-label={menuOpen ? 'Hide controls' : 'Show controls'}
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] text-[var(--ink-soft)] shadow-[0_6px_18px_rgb(var(--ink-rgb) / 0.08)] transition hover:bg-[var(--parchment)] hover:text-[var(--ink)]"
        >
          {menuOpen ? <X size={15} aria-hidden /> : <Menu size={15} aria-hidden />}
        </button>

        {menuOpen && (
          <div className="flex w-64 flex-col gap-2">
            <div className="pointer-events-auto rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] p-3 shadow-[0_6px_18px_rgb(var(--ink-rgb) / 0.08)]">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
                Scope
              </label>
              <select
                value={scope.kind === 'tag' ? `tag:${scope.tag}` : 'all'}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'all') setScope({ kind: 'all' });
                  else if (v.startsWith('tag:')) setScope({ kind: 'tag', tag: v.slice(4) });
                }}
                className="w-full rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
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

            <MenuSection label="Labels" open={sectLabels} onToggle={() => setSectLabels((o) => !o)}>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Visibility</span>
                  <span className="text-xs text-[var(--ink-soft)]">{labelModeLabel(labelMode)}</span>
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
                  className="w-full accent-[var(--wine)]"
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Opacity</span>
                  <span className="text-xs text-[var(--ink-soft)]">{Math.round(labelOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={labelOpacity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setLabelOpacity(v);
                    metaMap.set('labelOpacity', v);
                  }}
                  className="w-full accent-[var(--wine)]"
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Edge opacity</span>
                  <span className="text-xs text-[var(--ink-soft)]">{Math.round(edgeOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={edgeOpacity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setEdgeOpacity(v);
                    metaMap.set('edgeOpacity', v);
                  }}
                  className="w-full accent-[var(--wine)]"
                />
              </div>
            </MenuSection>

            <MenuSection label="Nodes" open={sectNodes} onToggle={() => setSectNodes((o) => !o)}>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Size</span>
                  <span className="text-xs text-[var(--ink-soft)]">{nodeScale.toFixed(1)}×</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={nodeScale}
                  onChange={(e) => metaMap.set('nodeScale', Number(e.target.value))}
                  className="w-full accent-[var(--wine)]"
                />
              </div>
            </MenuSection>

            <MenuSection label="Physics" open={sectPhysics} onToggle={() => setSectPhysics((o) => !o)}>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Gravity</span>
                  <span className="text-xs text-[var(--ink-soft)]">{gravity.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={gravity}
                  onChange={(e) => metaMap.set('gravity', Number(e.target.value))}
                  className="w-full accent-[var(--wine)]"
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Repulsion</span>
                  <span className="text-xs text-[var(--ink-soft)]">{repulsion}</span>
                </div>
                <input
                  type="range"
                  min={2}
                  max={30}
                  step={1}
                  value={repulsion}
                  onChange={(e) => metaMap.set('repulsion', Number(e.target.value))}
                  className="w-full accent-[var(--wine)]"
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Cluster spacing</span>
                  <span className="text-xs text-[var(--ink-soft)]">{pendingSpacing.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min={3}
                  max={20}
                  step={0.5}
                  value={pendingSpacing}
                  onChange={(e) => setPendingSpacing(Number(e.target.value))}
                  onPointerUp={(e) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    setClusterSpacing(v);
                    metaMap.set('clusterSpacing', v);
                  }}
                  className="w-full accent-[var(--wine)]"
                />
              </div>
            </MenuSection>

            {/* Colours */}
            <MenuSection label="Colours" open={sectColours} onToggle={() => setSectColours((o) => !o)}>
              <div className="text-xs text-[var(--ink-soft)]">
                Override the colour for any tag. Reset to default by clicking ⟲.
              </div>
              {paletteTags.length === 0 ? (
                <div className="text-xs text-[var(--ink-muted)]">No tags yet.</div>
              ) : (
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {paletteTags.map((t) => {
                    const current = tagColors[t] ?? colorForTags([t]);
                    const isOverride = t in tagColors;
                    return (
                      <li key={t} className="flex items-center gap-2">
                        <input
                          type="color"
                          value={current}
                          onChange={(e) => coloursMap.set(t, e.target.value)}
                          className="h-6 w-6 cursor-pointer rounded-[4px] border border-[var(--rule)] bg-transparent p-0"
                        />
                        <span className="flex-1 truncate text-xs text-[var(--ink)]">#{t}</span>
                        {isOverride && (
                          <button
                            type="button"
                            onClick={() => coloursMap.delete(t)}
                            title="Reset"
                            aria-label={`Reset colour for #${t}`}
                            className="rounded-[4px] px-1 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--ink)]/10 hover:text-[var(--ink)]"
                          >
                            ⟲
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </MenuSection>

            {/* Groups */}
            <MenuSection label="Groups" open={sectGroups} onToggle={() => setSectGroups((o) => !o)}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--ink-soft)]">Paint tags or notes a shared colour.</span>
                <button
                  type="button"
                  onClick={createGroup}
                  className="shrink-0 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-0.5 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
                >
                  + New
                </button>
              </div>
              {groups.length === 0 ? (
                <div className="text-xs text-[var(--ink-muted)]">No groups yet.</div>
              ) : (
                <ul className="max-h-60 space-y-2 overflow-y-auto">
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
            </MenuSection>

            <div className="pointer-events-auto flex items-center gap-1 rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] p-1 shadow-[0_6px_18px_rgb(var(--ink-rgb) / 0.08)]">
              <ToolButton onClick={() => zoomBy(1 / 1.4)} label="−" title="Zoom in" />
              <ToolButton onClick={() => zoomBy(1.4)} label="＋" title="Zoom out" />
              <ToolButton onClick={fit} label="Fit" title="Recentre" />
              <ToolButton onClick={clearPins} label="Unpin" title="Clear all pins" />
            </div>

            <div className="pointer-events-none text-xs text-[var(--ink-soft)]">
              {status === 'loading' && 'Loading graph…'}
              {status === 'ready' &&
                !linkMode &&
                edgeProgress.total > 0 &&
                edgeProgress.loaded < edgeProgress.total && (
                  <span className="inline-flex items-center gap-2">
                    <span>
                      Building links… {edgeProgress.loaded}/{edgeProgress.total}
                    </span>
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-24 overflow-hidden rounded-full bg-[var(--rule)]"
                    >
                      <span
                        className="block h-full bg-[var(--candlelight)] transition-[width] duration-150 ease-linear"
                        style={{
                          width: `${Math.round(
                            (edgeProgress.loaded / edgeProgress.total) * 100,
                          )}%`,
                        }}
                      />
                    </span>
                  </span>
                )}
              {status === 'ready' &&
                !linkMode &&
                (edgeProgress.total === 0 ||
                  edgeProgress.loaded >= edgeProgress.total) && (
                  <>
                    {counts.nodes} node{counts.nodes === 1 ? '' : 's'} ·{' '}
                    {counts.edges} edge{counts.edges === 1 ? '' : 's'} · drag
                    to anchor · shift-drag to pin · double-click to release
                  </>
                )}
              {status === 'ready' && linkMode && (
                <span className="font-medium text-[var(--wine)]">
                  Weave mode — drag from one node to another to forge a link
                </span>
              )}
              {status === 'error' && <span className="text-[var(--wine)]">Error: {error}</span>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function MenuSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="pointer-events-auto rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_6px_18px_rgb(var(--ink-rgb) / 0.08)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          {label}
        </span>
        <span className="text-[var(--ink-muted)]" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <div className="space-y-3 px-3 pb-3">{children}</div>}
    </div>
  );
}

// Exported so the 3D graph view can reuse the exact same row UI.
export function GroupEditor({
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
    <li className="rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] p-2">
      <div className="mb-1 flex items-center gap-2">
        <input
          type="color"
          value={group.color}
          onChange={(e) => onUpdate({ ...group, color: e.target.value })}
          className="h-6 w-6 shrink-0 cursor-pointer rounded-[4px] border border-[var(--rule)] bg-transparent p-0"
        />
        <input
          type="text"
          value={group.name}
          onChange={(e) => onUpdate({ ...group, name: e.target.value })}
          placeholder="Group name"
          className="min-w-0 flex-1 rounded-[6px] border border-[var(--rule)] bg-[var(--vellum)] px-1.5 py-0.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
        />
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete group "${group.name || 'Unnamed'}"?`)) onDelete();
          }}
          title="Delete group"
          aria-label={`Delete group ${group.name}`}
          className="rounded-[4px] px-1 text-xs text-[var(--wine)] transition hover:bg-[var(--wine)]/10"
        >
          ×
        </button>
      </div>

      {/* Tags row */}
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {group.tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--rule)] bg-[var(--vellum)] px-2 text-[10px] text-[var(--ink)]"
          >
            #{t}
            <button
              type="button"
              onClick={() => removeTag(t)}
              aria-label={`Remove tag ${t}`}
              className="text-[var(--ink-soft)] hover:text-[var(--wine)]"
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
            className="rounded-[6px] border border-[var(--rule)] bg-[var(--vellum)] px-1 py-0.5 text-[10px] text-[var(--ink-soft)]"
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
              className="inline-flex items-center gap-1 rounded-full border border-[var(--rule)] bg-[var(--vellum)] px-2 text-[10px] text-[var(--ink)]"
            >
              {label}
              <button
                type="button"
                onClick={() => removeNote(p)}
                aria-label={`Remove note ${label}`}
                className="text-[var(--ink-soft)] hover:text-[var(--wine)]"
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
          className="rounded-[6px] border border-[var(--rule)] bg-[var(--vellum)] px-1.5 py-0.5 text-[10px] text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)]"
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
          ? 'bg-[var(--wine)]/15 text-[var(--wine)] hover:bg-[var(--wine)]/25'
          : 'text-[var(--ink-soft)] hover:bg-[var(--candlelight)]/15 hover:text-[var(--ink)]')
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
                  stroke="var(--vellum)"
                  strokeWidth="1"
                >
                  <path d="M1 1 L1 11 L4 8 L6.5 13 L8.5 12.2 L6 7.3 L11 7.3 Z" />
                </svg>
                <div className="flex flex-col items-center">
                  {avatarUrl && (
                    <img
                      src={avatarUrl}
                      alt=""
                      className="h-10 w-10 rounded-full border-2 object-cover shadow-[0_2px_6px_rgb(var(--ink-rgb) / 0.3)]"
                      style={{ borderColor: r.color }}
                    />
                  )}
                  <span
                    className="whitespace-nowrap rounded-[4px] px-1 text-[10px] font-medium text-[var(--ink)]"
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


function GraphLoadingOverlay({
  status,
  error,
  counts,
  edgeProgress,
}: {
  status: 'idle' | 'loading' | 'error' | 'ready';
  error: string | null;
  counts: { nodes: number; edges: number };
  edgeProgress: { loaded: number; total: number };
}): React.JSX.Element | null {
  const buildingEdges =
    status === 'ready' &&
    edgeProgress.total > 0 &&
    edgeProgress.loaded < edgeProgress.total;
  const visible = status === 'idle' || status === 'loading' || status === 'error' || buildingEdges;
  if (!visible) return null;

  let title = 'Loading mind-map…';
  let detail: string | null = null;
  if (status === 'idle') title = 'Preparing mind-map…';
  if (status === 'loading') {
    title = 'Loading mind-map…';
    detail = 'Fetching nodes from the vault.';
  }
  if (buildingEdges) {
    title = 'Weaving links…';
    detail = `${edgeProgress.loaded} / ${edgeProgress.total} edges · ${counts.nodes} nodes placed`;
  }
  if (status === 'error') {
    title = 'Failed to load';
    detail = error ?? 'Unknown error';
  }

  // Edge-build phase only shows a slim top-bar; initial load shows centered card.
  if (buildingEdges) {
    const pct = Math.round((edgeProgress.loaded / edgeProgress.total) * 100);
    return (
      <div
        aria-live="polite"
        className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-[var(--rule)] bg-[var(--vellum)] px-3 py-1.5 text-xs text-[var(--ink-soft)] shadow-[0_6px_18px_rgb(var(--ink-rgb)/0.08)]"
      >
        <span className="inline-flex items-center gap-2">
          <GraphSpinner size={12} />
          <span>{title}</span>
          <span className="text-[var(--ink-muted)]">{detail}</span>
          <span
            aria-hidden
            className="inline-block h-1.5 w-24 overflow-hidden rounded-full bg-[var(--rule)]"
          >
            <span
              className="block h-full bg-[var(--candlelight)] transition-[width] duration-150 ease-linear"
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
    >
      <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] px-6 py-5 shadow-[0_10px_30px_rgb(var(--ink-rgb)/0.10)]">
        {status !== 'error' && <GraphSpinner size={24} />}
        <div className="text-sm font-medium text-[var(--ink)]">{title}</div>
        {detail && (
          <div
            className={`text-xs ${
              status === 'error' ? 'text-[var(--wine)]' : 'text-[var(--ink-soft)]'
            }`}
          >
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

function GraphSpinner({ size = 20 }: { size?: number }): React.JSX.Element {
  return (
    <>
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          border: '2px solid var(--rule)',
          borderTopColor: 'var(--candlelight)',
          borderRadius: '50%',
          display: 'inline-block',
          animation: 'graph2d-spin 0.9s linear infinite',
        }}
      />
      <style>{`@keyframes graph2d-spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}

export function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}
