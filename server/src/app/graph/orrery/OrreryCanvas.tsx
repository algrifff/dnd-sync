'use client';

// The Orrery: the world as a wheel of campaigns that morphs into a
// satellites view around any note. This file fetches the graph, owns the
// <canvas> and wires it to the engine (engine.ts); the panels are in
// OrreryChrome.tsx and every position comes from layout.ts.
//
// Loaded with next/dynamic ssr:false from OrreryLoader.tsx: it touches
// canvas, matchMedia-style browser APIs and getComputedStyle on mount.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { RELATION_TYPES } from '@compendium/shared';
import type { GraphPayload } from '@/lib/graph';
import { createEngine, type Engine, type Hover } from './engine';
import { buildModel, campaignLabel, type Model, type ONode } from './layout';
import { OrreryChrome } from './OrreryChrome';
import { kindSingular, kindTextColor, resolveFonts, resolvePalette, type Palette } from './palette';
import s from './orrery.module.css';

interface Props {
  worldName: string;
  /** Campaign slug to display name, from the campaigns table. */
  campNames: Record<string, string>;
  /** Note path from `?focus=`; opens focused when the viewer can see it. */
  initialFocus: string | null;
}

type Payload = Pick<GraphPayload, 'nodes' | 'edges' | 'relations'>;
type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; payload: Payload };

/** Same route the classic graph navigates to when a node is clicked. */
export const noteHref = (id: string): string => '/notes/' + id.split('/').map(encodeURIComponent).join('/');

function syncUrl(n: ONode | null): void {
  const url = new URL(window.location.href);
  if (n) url.searchParams.set('focus', n.id);
  else url.searchParams.delete('focus');
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}

export function OrreryCanvas(props: Props): ReactElement {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ state: 'loading' });
    fetch('/api/graph?scope=all&phase=full', { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Partial<Payload>;
        setLoad({ state: 'ready', payload: { nodes: body.nodes ?? [], edges: body.edges ?? [], relations: body.relations ?? [] } });
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name !== 'AbortError') setLoad({ state: 'error' });
      });
    return () => ctrl.abort();
  }, [attempt]);

  const model = useMemo(() => (load.state === 'ready' ? buildModel(load.payload) : null), [load]);

  return (
    <div className={s.root}>
      {load.state === 'loading' ? <div className={s.status}>Loading graph…</div> : null}
      {load.state === 'error' ? (
        <div className={s.status}>
          <span>
            The graph could not be loaded.{' '}
            <button className={s.btn} style={{ padding: '4px 12px', flex: 'none' }} onClick={() => setAttempt((a) => a + 1)}>Try again</button>
          </span>
        </div>
      ) : null}
      {model ? <OrreryStage model={model} {...props} /> : null}
    </div>
  );
}

function OrreryStage({ model, worldName, campNames, initialFocus }: Props & { model: Model }): ReactElement {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [hover, setHover] = useState<{ h: Hover; x: number; y: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const initialRef = useRef(initialFocus);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const pal = resolvePalette(root);
    const fonts = resolveFonts(root);
    const eng = createEngine(
      canvas,
      model,
      { worldName, campNames, relationTypes: RELATION_TYPES },
      {
        onHover: (h, x, y) => setHover(h ? { h, x, y } : null),
        onFocus: syncUrl,
      },
      pal,
      fonts,
    );
    const measure = (): void => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      const wide = w >= 900;
      eng.resize(w, h, window.devicePixelRatio || 1, wide ? 300 : 16, wide ? 262 : 16);
      setBox({ w, h });
    };
    measure();
    const initial = initialRef.current ? model.byId.get(initialRef.current) : undefined;
    eng.start(initial ?? null);
    setPalette(pal);
    setEngine(eng);

    const ro = new ResizeObserver(() => {
      if (root.clientWidth && root.clientHeight) measure();
    });
    ro.observe(root);

    // The canvas can't see CSS variables, so re-resolve when the theme flips.
    const retheme = (): void => {
      const next = resolvePalette(root);
      eng.setPalette(next, resolveFonts(root));
      setPalette(next);
    };
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    // Web fonts arrive after first paint; redraw once they are in.
    void document.fonts?.ready.then(retheme);

    return () => {
      ro.disconnect();
      mo.disconnect();
      eng.destroy();
      setEngine(null);
    };
  }, [model, worldName, campNames]);

  const open = useCallback((id: string) => router.push(noteHref(id)), [router]);

  const tip = hover && palette ? renderTip(hover.h, palette, model, campNames) : null;

  return (
    <div ref={rootRef} className={s.root}>
      <canvas ref={canvasRef} className={s.canvas} aria-label={`The Orrery of ${worldName || 'the world'}`} />
      {engine && palette ? (
        <OrreryChrome engine={engine} model={model} worldName={worldName} campNames={campNames} palette={palette} onOpen={open} />
      ) : null}
      {model.nodes.length === 0 ? <div className={s.empty}>No notes in this world yet.<br />Write one and it will appear here.</div> : null}
      {tip && hover ? (
        <div className={s.tip} style={{ left: Math.max(8, Math.min(hover.x + 14, box.w - 256)), top: Math.max(8, Math.min(hover.y + 14, box.h - 96)) }}>
          {tip}
        </div>
      ) : null}
    </div>
  );
}

function renderTip(h: Hover, palette: Palette, model: Model, campNames: Record<string, string>): ReactElement {
  if (h.type === 'sector') {
    return (
      <>
        <div className={s.caps}>Campaign</div>
        <div className={s.t}>{campaignLabel(h.camp, campNames)}</div>
        <div className={s.m}>{h.all} notes · click to open the sector</div>
      </>
    );
  }
  const n = h.n;
  const kind = n.isIndex ? (n.role === 'camp' ? 'Campaign index' : 'Index note') : kindSingular(n.kind);
  const camp = campaignLabel(n.campaign, campNames);
  return (
    <>
      <div className={s.caps} style={{ color: kindTextColor(palette, n.isIndex ? 'index' : n.kind) }}>{kind}</div>
      <div className={s.t}>{n.title}</div>
      <div className={s.m}>
        {camp} · {n.degree} links{n.rels.length ? ` · ${n.rels.length} relationships` : ''}
      </div>
      {n.isIndex && n.role === 'camp' && model.byId.has(n.id) ? <div className={s.m} style={{ marginTop: 3 }}>Click to open this campaign’s sector</div> : null}
    </>
  );
}
