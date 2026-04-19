'use client';

// Multiplayer freehand drawing on the note body.
//
// Canvas covers the entire scroll host (note-main), but stroke points
// are stored as fractions of the ARTICLE element (max-w-720). That
// way a stroke drawn over a word stays anchored to the same word on
// every peer's screen regardless of viewport width; points outside
// the article (in the padding) go negative or >1 and still render in
// consistent pixel-distance from the article across screens. The SVG
// portals into the scope and renders each stroke translated through
// the article's offset within the scope — no clamping.
//
// Ownership: each stroke carries the author's userId. Eraser only
// removes strokes you authored (by-id filter in the mutator); "Clear
// all" wipes only your own. You can see everyone else's strokes but
// can't touch them.
//
// Live streaming: strokes live in a Y.Map<strokeId, StrokeData>
// instead of a Y.Array so each ongoing stroke can be rewritten
// atomically as points accumulate. Local draws flush at ~50 ms
// intervals while the pointer's down so peers see the stroke build
// up in real time; a final flush on pointerup guarantees the
// complete stroke lands.
//
// Controls: three floating circular buttons top-left of the scroll
// host (brush / eraser / clear), portalled into the scope so they
// don't scroll away with the article. Colour swatch appears when
// brush is active.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { Brush, Eraser, Trash2 } from 'lucide-react';

type Stroke = {
  id: string;
  userId: string;
  color: string;
  // Points are fractions of the article's scrollWidth / scrollHeight.
  // Unclamped — a point at (-0.1, 0.5) renders 10% of article-width
  // to the left of the article, which is the same pixel offset from
  // the article on every screen (article width is 720 px everywhere).
  points: Array<[number, number]>;
};

type Mode = 'none' | 'brush' | 'eraser';

const PRESET_COLORS = [
  '#2A241E', // ink
  '#8B4A52', // wine
  '#7B8A5F', // moss
  '#6B7F8E', // sage
  '#B5572A', // embers
  '#D4A85A', // candlelight
];

const STROKE_WIDTH = 2;
// Eraser radius as a fraction of the article width. ~8 px at 720 px.
const ERASER_RADIUS = 0.012;
// Throttle interval for mid-draw Y flushes. 50 ms = 20 Hz, enough for
// peers to see smooth stroke growth without spamming the sync layer.
const FLUSH_INTERVAL_MS = 50;

export function DrawingOverlay({
  provider,
  user,
  scopeElementId = 'note-main',
  articleElementId = 'note-article',
}: {
  provider: HocuspocusProvider;
  user: { userId: string };
  scopeElementId?: string;
  articleElementId?: string;
}): React.JSX.Element | null {
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [article, setArticle] = useState<HTMLElement | null>(null);
  const [scopeDims, setScopeDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [articleDims, setArticleDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [articleOffset, setArticleOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [mode, setMode] = useState<Mode>('none');
  const [color, setColor] = useState<string>(PRESET_COLORS[0]!);
  const [swatchOpen, setSwatchOpen] = useState<boolean>(false);
  const colorInputRef = useRef<HTMLInputElement>(null);

  // Active-draw bookkeeping. Keeping the in-flight stroke in a ref
  // (plus a mirrored state for local render) lets event handlers and
  // the flush timer both append to the same object without React
  // update latency.
  const drawingRef = useRef<Stroke | null>(null);
  const [drawingTick, setDrawingTick] = useState<number>(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const strokesYMap = useMemo(
    () => provider.document.getMap<Stroke>('drawing-strokes'),
    [provider],
  );

  // Resolve the two host elements.
  useEffect(() => {
    let raf = 0;
    const tryResolve = (): void => {
      if (typeof document === 'undefined') return;
      const s = document.getElementById(scopeElementId) as HTMLElement | null;
      const a = document.getElementById(articleElementId) as HTMLElement | null;
      if (s && a) {
        setScope(s);
        setArticle(a);
        return;
      }
      raf = requestAnimationFrame(tryResolve);
    };
    tryResolve();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scopeElementId, articleElementId]);

  // Track scope + article dims and the article's offset within the
  // scope. Recomputed on resize + scroll so the render + event coords
  // stay consistent as the document grows.
  useEffect(() => {
    if (!scope || !article) return;
    const update = (): void => {
      setScopeDims({ w: scope.scrollWidth, h: scope.scrollHeight });
      setArticleDims({ w: article.scrollWidth, h: article.scrollHeight });
      // article.offsetLeft/Top is relative to its offsetParent, which
      // is the positioned scope (main has position:relative). That
      // gives us the article's x/y within scope's scroll coordinate
      // system — exactly what the SVG needs to translate points.
      setArticleOffset({ x: article.offsetLeft, y: article.offsetTop });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scope);
    ro.observe(article);
    const onScroll = (): void => update();
    scope.addEventListener('scroll', onScroll);
    window.addEventListener('resize', onScroll);
    return () => {
      ro.disconnect();
      scope.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [scope, article]);

  // Observe the shared Y.Map — remote add / update / delete reflows
  // the local strokes snapshot.
  useEffect(() => {
    const apply = (): void => {
      const next: Stroke[] = [];
      strokesYMap.forEach((value) => {
        if (value && typeof value === 'object') next.push(value);
      });
      setStrokes(next);
    };
    apply();
    strokesYMap.observe(apply);
    return () => strokesYMap.unobserve(apply);
  }, [strokesYMap]);

  // Convert viewport coords to article-local normalised fractions.
  // NOT clamped — strokes can extend outside the article.
  const coordsFromEvent = useCallback(
    (e: PointerEvent | React.PointerEvent): [number, number] | null => {
      if (!article) return null;
      const rect = article.getBoundingClientRect();
      const w = article.scrollWidth;
      const h = article.scrollHeight;
      if (w <= 0 || h <= 0) return null;
      return [(e.clientX - rect.left) / w, (e.clientY - rect.top) / h];
    },
    [article],
  );

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      const stroke = drawingRef.current;
      if (!stroke) return;
      // Set the stroke every flush. Y.Map replaces by key atomically;
      // peers' observers fire and their local strokes refresh with
      // the longer point list.
      strokesYMap.set(stroke.id, {
        id: stroke.id,
        userId: stroke.userId,
        color: stroke.color,
        points: stroke.points.slice(),
      });
    }, FLUSH_INTERVAL_MS);
  }, [strokesYMap]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (mode === 'none') return;
      const pt = coordsFromEvent(e);
      if (!pt) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      if (mode === 'brush') {
        const stroke: Stroke = {
          id: `${user.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          userId: user.userId,
          color,
          points: [pt],
        };
        drawingRef.current = stroke;
        setDrawingTick((t) => t + 1);
        // First flush immediately so peers see the starting dot.
        strokesYMap.set(stroke.id, { ...stroke });
      } else if (mode === 'eraser') {
        eraseAt(strokesYMap, user.userId, pt[0], pt[1]);
      }
    },
    [mode, coordsFromEvent, user.userId, color, strokesYMap],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (mode === 'none') return;
      const pt = coordsFromEvent(e);
      if (!pt) return;
      const stroke = drawingRef.current;
      if (mode === 'brush' && stroke) {
        const last = stroke.points[stroke.points.length - 1];
        if (last && last[0] === pt[0] && last[1] === pt[1]) return;
        stroke.points.push(pt);
        setDrawingTick((t) => t + 1);
        scheduleFlush();
      } else if (mode === 'eraser' && (e.buttons & 1) === 1) {
        eraseAt(strokesYMap, user.userId, pt[0], pt[1]);
      }
    },
    [mode, coordsFromEvent, user.userId, strokesYMap, scheduleFlush],
  );

  const onPointerUp = useCallback(() => {
    const stroke = drawingRef.current;
    drawingRef.current = null;
    setDrawingTick((t) => t + 1);
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (stroke && stroke.points.length > 1) {
      strokesYMap.set(stroke.id, { ...stroke });
    } else if (stroke) {
      // A single-point "stroke" is really a dud click. Remove it if
      // it made it into the map via the initial flush.
      strokesYMap.delete(stroke.id);
    }
  }, [strokesYMap]);

  const clearMine = useCallback(() => {
    const toDelete: string[] = [];
    strokesYMap.forEach((s, id) => {
      if (s.userId === user.userId) toDelete.push(id);
    });
    for (const id of toDelete) strokesYMap.delete(id);
    drawingRef.current = null;
    setDrawingTick((t) => t + 1);
  }, [strokesYMap, user.userId]);

  if (!scope || !article) return null;
  if (scopeDims.w === 0 || articleDims.w === 0) return null;

  // Merge the live in-flight stroke on top of the synced list so the
  // drawer sees pen-down feedback without waiting for the next flush.
  const drawing = drawingRef.current;
  void drawingTick; // ensure React rerenders when the ref mutates
  const renderable = drawing
    ? [...strokes.filter((s) => s.id !== drawing.id), drawing]
    : strokes;

  const toPixel = (x: number, y: number): [number, number] => [
    articleOffset.x + x * articleDims.w,
    articleOffset.y + y * articleDims.h,
  ];

  const svgPortal = createPortal(
    <svg
      aria-label="Drawings"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute inset-0"
      style={{
        width: scopeDims.w,
        height: scopeDims.h,
        pointerEvents: mode === 'none' ? 'none' : 'auto',
        cursor: mode === 'brush' ? 'crosshair' : mode === 'eraser' ? 'cell' : 'auto',
        zIndex: 4,
      }}
      viewBox={`0 0 ${scopeDims.w} ${scopeDims.h}`}
    >
      {renderable.map((s) => (
        <polyline
          key={s.id}
          points={s.points
            .map(([x, y]) => {
              const [px, py] = toPixel(x, y);
              return `${px},${py}`;
            })
            .join(' ')}
          fill="none"
          stroke={s.color}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.9}
        />
      ))}
    </svg>,
    scope,
  );

  const toolsPortal = createPortal(
    <>
      <div
        aria-label="Drawing tools"
        className="absolute left-4 top-4 flex flex-col gap-2"
        style={{ zIndex: 6, pointerEvents: 'auto' }}
      >
        <ToolButton
          icon={<Brush size={16} aria-hidden />}
          title={mode === 'brush' ? 'Stop drawing' : 'Draw'}
          active={mode === 'brush'}
          activeColor={color}
          onClick={() => {
            setMode((m) => (m === 'brush' ? 'none' : 'brush'));
            setSwatchOpen(false);
          }}
        />
        <ToolButton
          icon={<Eraser size={16} aria-hidden />}
          title={mode === 'eraser' ? 'Stop erasing' : 'Erase (your strokes)'}
          active={mode === 'eraser'}
          onClick={() => {
            setMode((m) => (m === 'eraser' ? 'none' : 'eraser'));
            setSwatchOpen(false);
          }}
        />
        <ToolButton
          icon={<Trash2 size={16} aria-hidden />}
          title="Clear your drawings"
          onClick={() => {
            if (confirm('Clear all your drawings on this note?')) clearMine();
          }}
        />

        {mode === 'brush' && (
          <div
            className="mt-1 flex flex-col items-center gap-1 rounded-full border border-[#D4C7AE] bg-[#FBF5E8] p-1.5 shadow-[0_4px_12px_rgba(42,36,30,0.12)]"
            onClick={() => setSwatchOpen((o) => !o)}
          >
            <button
              type="button"
              aria-label="Active colour"
              title="Pick colour"
              className="h-6 w-6 rounded-full border border-[#D4C7AE]"
              style={{ backgroundColor: color }}
            />
            {swatchOpen && (
              <div className="mt-1 flex flex-col gap-1">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Colour ${c}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setColor(c);
                      setSwatchOpen(false);
                    }}
                    className="h-5 w-5 rounded-full border transition hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor: c === color ? '#2A241E' : '#D4C7AE',
                    }}
                  />
                ))}
                <button
                  type="button"
                  aria-label="Custom colour"
                  onClick={(e) => {
                    e.stopPropagation();
                    colorInputRef.current?.click();
                  }}
                  className="h-5 w-5 rounded-full border border-[#D4C7AE] bg-gradient-to-br from-[#8B4A52] via-[#D4A85A] to-[#7B8A5F] transition hover:scale-110"
                />
                <input
                  ref={colorInputRef}
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="absolute h-0 w-0 opacity-0"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </>,
    scope,
  );

  return (
    <>
      {svgPortal}
      {toolsPortal}
    </>
  );
}

function eraseAt(
  strokesYMap: Y.Map<Stroke>,
  userId: string,
  x: number,
  y: number,
): void {
  const toDelete: string[] = [];
  strokesYMap.forEach((s, id) => {
    if (s.userId !== userId) return;
    for (const [px, py] of s.points) {
      if (Math.hypot(px - x, py - y) <= ERASER_RADIUS) {
        toDelete.push(id);
        break;
      }
    }
  });
  for (const id of toDelete) strokesYMap.delete(id);
}

function ToolButton({
  icon,
  title,
  onClick,
  active = false,
  activeColor,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  activeColor?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={
        'flex h-10 w-10 items-center justify-center rounded-full border shadow-[0_4px_12px_rgba(42,36,30,0.12)] transition hover:scale-105 ' +
        (active
          ? 'border-[#2A241E] bg-[#F4EDE0] text-[#2A241E]'
          : 'border-[#D4C7AE] bg-[#FBF5E8] text-[#5A4F42] hover:text-[#2A241E]')
      }
      style={
        active && activeColor
          ? { boxShadow: `0 0 0 2px ${activeColor}, 0 4px 12px rgba(42,36,30,0.12)` }
          : undefined
      }
    >
      {icon}
    </button>
  );
}
