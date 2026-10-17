'use client';

// Compact Satellites view of the open note in the right sidebar: its
// direct links around it in one sector per kind, drawn by the Orrery's own
// layout, palette and stroke code (graph/orrery/mini.ts). Clicking a
// satellite opens that note. Loaded client-only via MiniGraphLoader.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import type { GraphPayload } from '@/lib/graph';
import { buildModel } from '../graph/orrery/layout';
import { createMini, type Mini } from '../graph/orrery/mini';
import { resolveFonts, resolvePalette } from '../graph/orrery/palette';

type Payload = Pick<GraphPayload, 'nodes' | 'edges' | 'relations'>;
type Load = { state: 'loading' } | { state: 'empty' } | { state: 'ready'; payload: Payload };

const SIDE = 260;

const noteHref = (id: string): string => '/notes/' + id.split('/').map(encodeURIComponent).join('/');

export function MiniGraph({ path }: { path: string }): ReactElement {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ state: 'loading' });
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    fetch(`/api/graph/neighborhood/${encoded}?depth=1`, { cache: 'no-store', signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) return setLoad({ state: 'empty' });
        const body = (await res.json()) as Partial<Payload>;
        const payload: Payload = { nodes: body.nodes ?? [], edges: body.edges ?? [], relations: body.relations ?? [] };
        setLoad(payload.nodes.length > 1 ? { state: 'ready', payload } : { state: 'empty' });
      })
      .catch(() => {
        /* keep the sidebar quiet if the endpoint fails */
      });
    return () => ctrl.abort();
  }, [path]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (load.state !== 'ready' || !host || !canvas) return;
    const model = buildModel(load.payload);
    const centre = model.byId.get(path);
    if (!centre) return;
    let mini: Mini | null = createMini(canvas, model, centre, resolvePalette(host), resolveFonts(host), {
      onOpen: (n) => router.push(noteHref(n.id)),
    });
    mini.resize(SIDE, window.devicePixelRatio || 1);

    // A canvas cannot read CSS variables: resolve them again when the theme flips.
    const retheme = (): void => mini?.setPalette(resolvePalette(host), resolveFonts(host));
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    // Web fonts arrive after first paint.
    void document.fonts?.ready.then(retheme);
    return () => {
      mo.disconnect();
      mini?.destroy();
      mini = null;
    };
  }, [load, path, router]);

  if (load.state === 'empty') return <p className="px-1 text-xs text-[var(--ink-soft)]">No links yet.</p>;

  return (
    <div
      ref={hostRef}
      className="overflow-hidden rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)]"
      style={{ width: SIDE, height: SIDE }}
    >
      {load.state === 'ready' ? <canvas ref={canvasRef} role="img" aria-label="Link neighbourhood of this note" /> : null}
    </div>
  );
}
