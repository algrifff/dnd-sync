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

type LabelMode = 'none' | 'some' | 'all';

const PIN_STORAGE_PREFIX = 'compendium.graph.pins.';
const COLOUR_STORAGE_PREFIX = 'compendium.graph.tagColors.';
const LABEL_STORAGE_PREFIX = 'compendium.graph.labels.';

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
  const rafRef = useRef<number>(0);
  const pinsRef = useRef<Record<string, { x: number; y: number }>>({});
  const draggedRef = useRef<{ node: string; x: number; y: number } | null>(null);

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
  const [palette, setPalette] = useState<boolean>(false);
  const [nodesPayload, setNodesPayload] = useState<GraphPayload['nodes']>([]);

  const scopeParam = useMemo(() => {
    if (scope.kind === 'tag') return `tag:${scope.tag}`;
    return 'all';
  }, [scope]);

  // Resolve a node's colour: user override for the first matching tag
  // wins, otherwise fall through to the priority-default palette.
  const colorFor = useCallback(
    (tags: readonly string[]): string => {
      for (const t of tags) {
        const override = tagColors[t.toLowerCase()];
        if (override) return override;
      }
      return colorForTags(tags);
    },
    [tagColors],
  );

  // ── one-time localStorage load for pins + overrides + label mode ───
  useEffect(() => {
    try {
      const pinsRaw = localStorage.getItem(PIN_STORAGE_PREFIX + groupId);
      if (pinsRaw) {
        const parsed = JSON.parse(pinsRaw) as unknown;
        if (parsed && typeof parsed === 'object') {
          pinsRef.current = parsed as Record<string, { x: number; y: number }>;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const coloursRaw = localStorage.getItem(COLOUR_STORAGE_PREFIX + groupId);
      if (coloursRaw) {
        const parsed = JSON.parse(coloursRaw) as unknown;
        if (parsed && typeof parsed === 'object') {
          setTagColors(parsed as Record<string, string>);
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const mode = localStorage.getItem(LABEL_STORAGE_PREFIX + groupId) as LabelMode | null;
      if (mode === 'none' || mode === 'some' || mode === 'all') setLabelMode(mode);
    } catch {
      /* ignore */
    }
  }, [groupId]);

  // Persist colour + label preferences.
  useEffect(() => {
    try {
      localStorage.setItem(COLOUR_STORAGE_PREFIX + groupId, JSON.stringify(tagColors));
    } catch {
      /* ignore */
    }
  }, [tagColors, groupId]);
  useEffect(() => {
    try {
      localStorage.setItem(LABEL_STORAGE_PREFIX + groupId, labelMode);
    } catch {
      /* ignore */
    }
  }, [labelMode, groupId]);

  // ── main load + render cycle ────────────────────────────────────────
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

        sigmaRef.current?.kill();
        sigmaRef.current = null;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;

        setNodesPayload(payload.nodes);

        const g = new Graph({ multi: false, type: 'directed', allowSelfLoops: false });
        const pins = pinsRef.current;
        for (const n of payload.nodes) {
          const pin = pins[n.id];
          g.addNode(n.id, {
            label: n.title,
            size: radiusForDegree(n.degree),
            color: colorFor(n.tags),
            x: pin?.x ?? (Math.random() * 2 - 1),
            y: pin?.y ?? (Math.random() * 2 - 1),
            tags: n.tags,
            degree: n.degree,
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
              gravity: 1,
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
            // Re-apply fixed positions AFTER the iteration so physics
            // can't knock pinned / dragged nodes off.
            for (const [id, pos] of Object.entries(pinsRef.current)) {
              if (g.hasNode(id)) {
                g.setNodeAttribute(id, 'x', pos.x);
                g.setNodeAttribute(id, 'y', pos.y);
              }
            }
            const dragged = draggedRef.current;
            if (dragged && g.hasNode(dragged.node)) {
              g.setNodeAttribute(dragged.node, 'x', dragged.x);
              g.setNodeAttribute(dragged.node, 'y', dragged.y);
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        // ── Interactions ─────────────────────────────────────────────
        renderer.on('clickNode', ({ node, event }) => {
          // If the click is the tail of a drag, don't navigate.
          const ev = event?.original as MouseEvent | undefined;
          if (ev && Math.hypot(ev.movementX ?? 0, ev.movementY ?? 0) > 3) return;
          router.push('/notes/' + node.split('/').map(encodeURIComponent).join('/'));
        });

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
        });
        renderer.on('leaveNode', () => {
          renderer.setSetting('nodeReducer', null);
          renderer.setSetting('edgeReducer', null);
        });

        // Drag handling. Plain drag holds the node at cursor while
        // physics keeps running (Obsidian feel). Shift-drag persists
        // the final position as a pin.
        let shiftHeld = false;
        renderer.on('downNode', ({ node, event }) => {
          const ev = event?.original as MouseEvent | undefined;
          shiftHeld = !!ev?.shiftKey;
          const { x, y } = g.getNodeAttributes(node) as { x: number; y: number };
          draggedRef.current = { node, x, y };
          event?.preventSigmaDefault?.();
        });
        const stage = renderer.getMouseCaptor();
        stage.on('mousemovebody', (e) => {
          const dragged = draggedRef.current;
          if (!dragged) return;
          const p = renderer.viewportToGraph({ x: e.x, y: e.y });
          dragged.x = p.x;
          dragged.y = p.y;
          e.preventSigmaDefault();
          e.original.preventDefault();
          e.original.stopPropagation();
        });
        const stopDrag = (): void => {
          const dragged = draggedRef.current;
          if (!dragged) return;
          if (shiftHeld) {
            pinsRef.current[dragged.node] = { x: dragged.x, y: dragged.y };
            try {
              localStorage.setItem(
                PIN_STORAGE_PREFIX + groupId,
                JSON.stringify(pinsRef.current),
              );
            } catch {
              /* ignore */
            }
          }
          draggedRef.current = null;
          shiftHeld = false;
        };
        stage.on('mouseup', stopDrag);

        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load graph');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      sigmaRef.current?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [scopeParam, groupId, router, colorFor, labelMode]);

  // Live re-colour when tag overrides change without rebuilding the
  // graph (keeps physics running; feels instant).
  useEffect(() => {
    const g = graphRef.current;
    const renderer = sigmaRef.current;
    if (!g || !renderer) return;
    g.forEachNode((id, attrs) => {
      const tags = (attrs.tags as string[] | undefined) ?? [];
      g.setNodeAttribute(id, 'color', colorFor(tags));
    });
  }, [tagColors, colorFor]);

  // Apply label-mode changes to a live sigma without rebuilding.
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    const s = labelModeToSigmaSettings(labelMode);
    for (const [k, v] of Object.entries(s)) {
      renderer.setSetting(k as Parameters<typeof renderer.setSetting>[0], v as never);
    }
  }, [labelMode]);

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
    pinsRef.current = {};
    try {
      localStorage.removeItem(PIN_STORAGE_PREFIX + groupId);
    } catch {
      /* ignore */
    }
  }, [groupId]);

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
                        onChange={(e) =>
                          setTagColors((prev) => ({ ...prev, [t]: e.target.value }))
                        }
                        className="h-6 w-6 cursor-pointer rounded-[4px] border border-[#D4C7AE] bg-transparent p-0"
                      />
                      <span className="flex-1 truncate text-xs text-[#2A241E]">#{t}</span>
                      {isOverride && (
                        <button
                          type="button"
                          onClick={() =>
                            setTagColors((prev) => {
                              const next = { ...prev };
                              delete next[t];
                              return next;
                            })
                          }
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

        <div className="pointer-events-none text-xs text-[#5A4F42]">
          {status === 'loading' && 'Loading graph…'}
          {status === 'ready' && (
            <>
              {counts.nodes} node{counts.nodes === 1 ? '' : 's'} ·{' '}
              {counts.edges} edge{counts.edges === 1 ? '' : 's'} · drag = move ·
              shift-drag = pin
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
