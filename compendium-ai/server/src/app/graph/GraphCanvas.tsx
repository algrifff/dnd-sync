'use client';

// Full-viewport mind-map.
//
// Stack:
//   * graphology       — in-memory graph model
//   * forceatlas2      — gentle physics layout; synchronous here, runs
//                        on main thread for a capped iteration count
//                        (web-worker variant is import-only under CJS
//                        build and throws under Next's ESM chunking)
//   * sigma            — WebGL renderer
//
// Interactions:
//   * click a node → navigate to /notes/<path>
//   * hover a node → fade non-1-hop neighbours
//   * shift-drag   → pin a node at its drop position; position stored
//                    in localStorage keyed by groupId so pins survive
//                    reloads
//
// Controls panel (top-left):
//   * scope: all / folder:<...> / tag:<tag>
//   * zoom in / out / fit

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { colorForTags, radiusForDegree } from './graphStyle';

type GraphPayload = {
  nodes: Array<{ id: string; title: string; tags: string[]; degree: number }>;
  edges: Array<{ source: string; target: string }>;
};

type Scope =
  | { kind: 'all' }
  | { kind: 'tag'; tag: string };

const PIN_STORAGE_PREFIX = 'compendium.graph.pins.';

export function GraphCanvas({
  groupId,
  allTags,
}: {
  groupId: string;
  allTags: string[];
}): React.JSX.Element {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const pinsRef = useRef<Record<string, { x: number; y: number }>>({});
  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ nodes: number; edges: number }>({
    nodes: 0,
    edges: 0,
  });

  const scopeParam = useMemo(() => {
    if (scope.kind === 'tag') return `tag:${scope.tag}`;
    return 'all';
  }, [scope]);

  // Load pins once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PIN_STORAGE_PREFIX + groupId);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
          pinsRef.current = parsed as Record<string, { x: number; y: number }>;
        }
      }
    } catch {
      /* quota / private-mode — no pins this session */
    }
  }, [groupId]);

  // Fetch + render whenever scope changes.
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    setStatus('loading');
    setError(null);

    (async () => {
      try {
        const res = await fetch(`/api/graph?scope=${encodeURIComponent(scopeParam)}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as GraphPayload;
        if (cancelled) return;

        // Tear down any previous Sigma instance before building the
        // next one — otherwise the WebGL context accumulates.
        sigmaRef.current?.kill();
        sigmaRef.current = null;

        const g = new Graph({ multi: false, type: 'directed', allowSelfLoops: false });

        // Seed node positions with either the stored pin or a jitter
        // around the origin; forceatlas2 relaxes the layout from
        // whatever initial positions we provide.
        const pins = pinsRef.current;
        for (const n of payload.nodes) {
          const pin = pins[n.id];
          g.addNode(n.id, {
            label: n.title,
            size: radiusForDegree(n.degree),
            color: colorForTags(n.tags),
            x: pin?.x ?? Math.random() * 2 - 1,
            y: pin?.y ?? Math.random() * 2 - 1,
            // sigma uses this to skip re-layout on pinned nodes if we
            // choose to honour it; we also consult `pinsRef` directly
            // on drag end.
            pinned: !!pin,
          });
        }
        for (const e of payload.edges) {
          if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
          const edgeId = `${e.source}→${e.target}`;
          if (g.hasEdge(edgeId)) continue;
          g.addEdgeWithKey(edgeId, e.source, e.target, {
            size: 1,
            color: 'rgba(42, 36, 30, 0.4)',
          });
        }

        // Run forceatlas2 for a capped number of iterations. Sync
        // avoids the worker import path entirely (which has ESM/CJS
        // edges under Next); at 300 iterations on ~1500 nodes this
        // completes in a few hundred ms on desktop.
        if (g.order > 1) {
          const settings = forceAtlas2.inferSettings(g);
          forceAtlas2.assign(g, {
            iterations: g.order < 200 ? 200 : g.order < 800 ? 100 : 60,
            settings: {
              ...settings,
              gravity: 1,
              scalingRatio: 10,
              slowDown: 5,
              barnesHutOptimize: g.order > 500,
            },
          });
        }

        const renderer = new Sigma(g, container, {
          defaultNodeColor: '#5A4F42',
          defaultEdgeColor: 'rgba(42, 36, 30, 0.4)',
          labelColor: { color: '#2A241E' },
          labelWeight: '500',
          labelFont: 'Inter, system-ui, sans-serif',
          labelSize: 12,
          labelDensity: 0.6,
          renderLabels: true,
          renderEdgeLabels: false,
        });

        sigmaRef.current = renderer;
        graphRef.current = g;
        setCounts({ nodes: g.order, edges: g.size });

        // Click → navigate to note.
        renderer.on('clickNode', ({ node }) => {
          router.push('/notes/' + node.split('/').map(encodeURIComponent).join('/'));
        });

        // Hover highlighting: fade everything not in the 1-hop
        // neighbourhood of the hovered node.
        renderer.on('enterNode', ({ node }) => {
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
          renderer.refresh();
        });
        renderer.on('leaveNode', () => {
          renderer.setSetting('nodeReducer', null);
          renderer.setSetting('edgeReducer', null);
          renderer.refresh();
        });

        // Shift-drag pin: capture shift-key drags on nodes; on drop,
        // persist the node's current position under the groupId-keyed
        // pin map so it sticks across reloads.
        let draggedNode: string | null = null;
        let shiftDrag = false;
        renderer.on('downNode', ({ node, event }) => {
          const sourceEvent = event?.original as MouseEvent | undefined;
          if (sourceEvent?.shiftKey) {
            shiftDrag = true;
            draggedNode = node;
            // prevent sigma's default camera drag
            event?.preventSigmaDefault?.();
          }
        });
        const dragStage = renderer.getMouseCaptor();
        dragStage.on('mousemovebody', (e) => {
          if (!draggedNode || !shiftDrag) return;
          const pos = renderer.viewportToGraph({ x: e.x, y: e.y });
          g.setNodeAttribute(draggedNode, 'x', pos.x);
          g.setNodeAttribute(draggedNode, 'y', pos.y);
          e.preventSigmaDefault();
          e.original.preventDefault();
          e.original.stopPropagation();
        });
        const stopDrag = (): void => {
          if (!draggedNode) return;
          const x = g.getNodeAttribute(draggedNode, 'x') as number;
          const y = g.getNodeAttribute(draggedNode, 'y') as number;
          pinsRef.current[draggedNode] = { x, y };
          try {
            localStorage.setItem(
              PIN_STORAGE_PREFIX + groupId,
              JSON.stringify(pinsRef.current),
            );
          } catch {
            /* ignore */
          }
          draggedNode = null;
          shiftDrag = false;
        };
        dragStage.on('mouseup', stopDrag);

        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load graph');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      sigmaRef.current?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [scopeParam, groupId, router]);

  const zoomBy = useCallback((factor: number) => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    const camera = renderer.getCamera();
    camera.animatedZoom({ factor, duration: 200 });
  }, []);

  const fit = useCallback(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    renderer.getCamera().animatedReset({ duration: 200 });
  }, []);

  const clearPins = useCallback(() => {
    pinsRef.current = {};
    try {
      localStorage.removeItem(PIN_STORAGE_PREFIX + groupId);
    } catch {
      /* ignore */
    }
  }, [groupId]);

  return (
    <>
      <div ref={containerRef} className="absolute inset-0 bg-[#F4EDE0]" />

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

        <div className="pointer-events-auto flex items-center gap-1 rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] p-1 shadow-[0_6px_18px_rgba(42,36,30,0.08)]">
          <ToolButton onClick={() => zoomBy(1 / 1.4)} label="−" title="Zoom in" />
          <ToolButton onClick={() => zoomBy(1.4)} label="＋" title="Zoom out" />
          <ToolButton onClick={fit} label="Fit" title="Recentre" />
          <ToolButton onClick={clearPins} label="Unpin" title="Clear all pins" />
        </div>

        <div className="pointer-events-none text-xs text-[#5A4F42]">
          {status === 'loading' && 'Loading graph…'}
          {status === 'ready' && (
            <>
              {counts.nodes} node{counts.nodes === 1 ? '' : 's'} ·{' '}
              {counts.edges} edge{counts.edges === 1 ? '' : 's'} · shift-drag
              to pin
            </>
          )}
          {status === 'error' && <span className="text-[#8B4A52]">Error: {error}</span>}
        </div>
      </div>
    </>
  );
}

function ToolButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded-[6px] px-2 py-1 text-xs font-medium text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E]"
    >
      {label}
    </button>
  );
}
