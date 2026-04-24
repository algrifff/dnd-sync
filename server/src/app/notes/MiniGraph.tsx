'use client';

// 280x280 Sigma canvas in the note-page right sidebar. Shows the
// 1-hop neighbourhood around the current note; clicking a neighbour
// navigates to that note. The center node is rendered slightly larger
// and in the accent colour so it's clearly "you".

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { colorForTags, radiusForDegree } from '../graph/graphStyle';

type Payload = {
  nodes: Array<{ id: string; title: string; tags: string[]; degree: number }>;
  edges: Array<{ source: string; target: string }>;
  center: string;
};

const SIDE = 260;

export function MiniGraph({ path }: { path: string }): React.JSX.Element {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      try {
        const encoded = path.split('/').map(encodeURIComponent).join('/');
        const res = await fetch(`/api/graph/neighborhood/${encoded}?depth=1`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const payload = (await res.json()) as Payload;
        if (cancelled) return;

        sigmaRef.current?.kill();
        sigmaRef.current = null;

        if (payload.nodes.length <= 1) {
          // Only the centre exists — nothing to show.
          container.innerHTML = '';
          const note = document.createElement('p');
          note.textContent = 'No links yet.';
          note.className = 'text-xs text-[var(--ink-soft)] px-1';
          container.appendChild(note);
          return;
        }

        const g = new Graph({ multi: false, type: 'directed', allowSelfLoops: false });
        for (const n of payload.nodes) {
          const isCenter = n.id === payload.center;
          g.addNode(n.id, {
            label: n.title,
            size: isCenter ? radiusForDegree(n.degree) + 2 : radiusForDegree(n.degree),
            color: isCenter ? 'var(--wine)' : colorForTags(n.tags),
            x: Math.random() * 2 - 1,
            y: Math.random() * 2 - 1,
          });
        }
        for (const e of payload.edges) {
          if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
          const key = `${e.source}→${e.target}`;
          if (g.hasEdge(key)) continue;
          g.addEdgeWithKey(key, e.source, e.target, {
            size: 0.8,
            color: 'rgb(var(--ink-rgb) / 0.35)',
          });
        }

        if (g.order > 1) {
          const settings = forceAtlas2.inferSettings(g);
          forceAtlas2.assign(g, {
            iterations: 150,
            settings: {
              ...settings,
              gravity: 2,
              scalingRatio: 8,
              slowDown: 4,
            },
          });
        }

        const renderer = new Sigma(g, container, {
          defaultNodeColor: 'var(--ink-soft)',
          defaultEdgeColor: 'rgb(var(--ink-rgb) / 0.35)',
          labelColor: { color: 'var(--ink)' },
          labelWeight: '500',
          labelFont: 'Inter, system-ui, sans-serif',
          labelSize: 10,
          labelDensity: 0.3,
          renderLabels: true,
        });
        sigmaRef.current = renderer;

        renderer.on('clickNode', ({ node }) => {
          if (node === payload.center) return;
          router.push('/notes/' + node.split('/').map(encodeURIComponent).join('/'));
        });
      } catch {
        /* silent — keep the sidebar clean if the endpoint 500s */
      }
    })();

    return () => {
      cancelled = true;
      sigmaRef.current?.kill();
      sigmaRef.current = null;
    };
  }, [path, router]);

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)]"
      style={{ width: SIDE, height: SIDE }}
      aria-label="Link neighbourhood"
    />
  );
}
