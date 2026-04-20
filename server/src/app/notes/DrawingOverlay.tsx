'use client';

// Multiplayer freehand drawing on the note body.
//
// Coordinate model: the note column is forced to a fixed
// VIRTUAL_WIDTH (720 px) on every screen and text inside it reflows
// identically, so stroke points stored in raw virtual pixels land on
// the same word for every peer. The SVG overlay is a child of the
// 720-px column (#note-scroll-body) and covers its full scroll
// height — title + tags + body — so annotations can sit anywhere in
// the note.
//
// Zoom: purely local, applied via CSS `zoom` on the column element.
// One user may view at 150 % on a big monitor while another works at
// 100 % on a laptop; both draw and render strokes in the same
// virtual-px space, so annotations land identically regardless of
// each viewer's zoom.
//
// Ownership: each stroke carries the author's userId. Eraser only
// removes strokes you authored; "Clear your drawings" wipes only
// your own. You can see everyone else's but can't touch them.
//
// Live streaming: strokes live in a Y.Map<strokeId, StrokeData>
// (keyed so each in-progress stroke can be rewritten atomically as
// points accumulate). Local draws flush at ~50 ms intervals while
// the pointer's down so peers see each stroke build in real time; a
// final flush on pointerup guarantees the complete stroke lands.
//
// Data shape is not backwards compatible with the old fraction-based
// overlay; a v2 Y.Map key keeps old drawings out of sight while we
// seed the new coord system.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { Brush, Eraser, Trash2, ZoomIn, ZoomOut } from 'lucide-react';

type Stroke = {
  id: string;
  userId: string;
  color: string;
  // Points are virtual pixels inside the fixed 720-px column.
  // Horizontal range: [0, 720]. Vertical: [0, columnScrollHeight].
  points: Array<[number, number]>;
};

type Mode = 'none' | 'brush' | 'eraser';

// The note column is much wider than the text column inside it, so
// annotations can live in the margins (a la Figma's infinite canvas
// around focused content). Text still wraps to its own narrower
// inner width for readability — only the drawing canvas is this wide.
const VIRTUAL_WIDTH = 1600;
// Eraser radius in virtual px (same scale as stroke coords).
const ERASER_RADIUS = 10;
// Throttle interval for mid-draw Y flushes. 16 ms ≈ 60 Hz so remote
// peers see strokes grow at near-frame-rate before network RTT adds latency.
const FLUSH_INTERVAL_MS = 16;
const STROKE_WIDTH = 2;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

const PRESET_COLORS = [
  '#2A241E', // ink
  '#8B4A52', // wine
  '#7B8A5F', // moss
  '#6B7F8E', // sage
  '#B5572A', // embers
  '#D4A85A', // candlelight
];

export function DrawingOverlay({
  provider,
  user,
  columnElementId = 'note-scroll-body',
  toolsElementId = 'note-tools-anchor',
}: {
  provider: HocuspocusProvider;
  user: { userId: string };
  columnElementId?: string;
  /** A non-scrolling ancestor where the floating tool palette lives.
   *  Separated from the drawing column so the tools stay pinned in
   *  the viewport as the user scrolls the note. */
  toolsElementId?: string;
}): React.JSX.Element | null {
  const [toolsAnchor, setToolsAnchor] = useState<HTMLElement | null>(null);
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const [columnHeight, setColumnHeight] = useState<number>(0);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [mode, setMode] = useState<Mode>('none');
  const [color, setColor] = useState<string>(PRESET_COLORS[0]!);
  const [swatchOpen, setSwatchOpen] = useState<boolean>(false);
  const [zoom, setZoom] = useState<number>(1);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Live-draw bookkeeping. Keeping the in-flight stroke in a ref
  // (plus a tick to re-render the preview) lets handlers and the
  // flush timer append to the same object without React latency.
  const drawingRef = useRef<Stroke | null>(null);
  const [drawingTick, setDrawingTick] = useState<number>(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // v3 key — v2 held 720-wide strokes; widening the canvas to 1600
  // would misplace them, so start fresh. Old data sits inert in the
  // doc and can be dropped later.
  const strokesYMap = useMemo(
    () => provider.document.getMap<Stroke>('drawing-strokes-v3'),
    [provider],
  );

  // Resolve host elements.
  useEffect(() => {
    let raf = 0;
    const tryResolve = (): void => {
      if (typeof document === 'undefined') return;
      const t = document.getElementById(toolsElementId) as HTMLElement | null;
      const c = document.getElementById(columnElementId) as HTMLElement | null;
      if (t && c) {
        setToolsAnchor(t);
        setColumn(c);
        return;
      }
      raf = requestAnimationFrame(tryResolve);
    };
    tryResolve();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [toolsElementId, columnElementId]);

  // Track column height so the SVG grows as content is added. Width
  // is fixed at VIRTUAL_WIDTH — no observation needed.
  useEffect(() => {
    if (!column) return;
    const update = (): void => setColumnHeight(column.scrollHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(column);
    const mo = new MutationObserver(update);
    mo.observe(column, { subtree: true, childList: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [column]);

  // Apply zoom to the column. Using CSS `zoom` (not transform:scale)
  // so layout reserves the scaled space and the browser scroll host
  // behaves naturally.
  useEffect(() => {
    if (!column) return;
    column.style.zoom = String(zoom);
    return () => {
      column.style.zoom = '';
    };
  }, [column, zoom]);

  // Observe the shared Y.Map.
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

  // Convert viewport coords to virtual-px. The SVG's bounding rect is
  // post-zoom, so rect.width / VIRTUAL_WIDTH yields the effective
  // scale to invert.
  const coordsFromEvent = useCallback(
    (e: PointerEvent | React.PointerEvent): [number, number] | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const scale = rect.width / VIRTUAL_WIDTH;
      return [
        (e.clientX - rect.left) / scale,
        (e.clientY - rect.top) / scale,
      ];
    },
    [],
  );

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      const stroke = drawingRef.current;
      if (!stroke) return;
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

  if (!toolsAnchor || !column) return null;
  // Minimum canvas height: enough virtual pixels to fill the viewport.
  // The column has CSS zoom applied, so we divide by zoom to get the
  // equivalent virtual-pixel count that will visually cover the screen.
  const minVirtualHeight =
    typeof window !== 'undefined' ? Math.ceil(window.innerHeight / zoom) : 800;
  const svgHeight = Math.max(columnHeight, minVirtualHeight);

  const drawing = drawingRef.current;
  void drawingTick;
  const renderable = drawing
    ? [...strokes.filter((s) => s.id !== drawing.id), drawing]
    : strokes;

  // SVG sits inside the column (which carries zoom), so it scales
  // with the column. viewBox matches the virtual canvas exactly.
  const svgPortal = createPortal(
    <svg
      ref={svgRef}
      aria-label="Drawings"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute inset-0"
      style={{
        width: VIRTUAL_WIDTH,
        height: svgHeight,
        pointerEvents: mode === 'none' ? 'none' : 'auto',
        cursor: mode === 'brush' ? 'crosshair' : mode === 'eraser' ? 'cell' : 'auto',
        zIndex: 4,
      }}
      viewBox={`0 0 ${VIRTUAL_WIDTH} ${svgHeight}`}
    >
      {renderable.map((s) => (
        <polyline
          key={s.id}
          points={s.points.map(([x, y]) => `${x},${y}`).join(' ')}
          fill="none"
          stroke={s.color}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.9}
        />
      ))}
    </svg>,
    column,
  );

  const zoomOut = (): void =>
    setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - ZOOM_STEP) * 100) / 100));
  const zoomIn = (): void =>
    setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + ZOOM_STEP) * 100) / 100));
  const zoomReset = (): void => setZoom(1);

  const toolsPortal = createPortal(
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
              {/* The gradient swatch is purely decorative; the real
                  <input type="color"> lives on top of it with zero
                  opacity so browsers open their native picker on
                  click (hidden inputs off-screen don't trigger the
                  picker reliably in every browser). */}
              <div
                className="relative h-5 w-5 overflow-hidden rounded-full border border-[#D4C7AE] bg-gradient-to-br from-[#8B4A52] via-[#D4A85A] to-[#7B8A5F] transition hover:scale-110"
                onClick={(e) => e.stopPropagation()}
                title="Custom colour"
              >
                <input
                  ref={colorInputRef}
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  aria-label="Custom colour"
                  className="absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent p-0 opacity-0"
                />
              </div>
            </div>
          )}
        </div>
      )}

    </div>,
    toolsAnchor,
  );

  const zoomPortal = createPortal(
    <div
      aria-label="Drawing zoom"
      className="absolute bottom-4 left-4 flex flex-col items-center gap-1 rounded-full border border-[#D4C7AE] bg-[#FBF5E8] p-1 shadow-[0_4px_12px_rgba(42,36,30,0.12)]"
      style={{ zIndex: 6, pointerEvents: 'auto' }}
    >
      <ToolButton
        icon={<ZoomIn size={14} aria-hidden />}
        title="Zoom in"
        onClick={zoomIn}
        small
      />
      <button
        type="button"
        onClick={zoomReset}
        title={`Zoom ${Math.round(zoom * 100)}% — click to reset`}
        aria-label="Reset zoom"
        className="rounded-full px-1 text-[10px] font-medium text-[#5A4F42] transition hover:text-[#2A241E]"
      >
        {Math.round(zoom * 100)}%
      </button>
      <ToolButton
        icon={<ZoomOut size={14} aria-hidden />}
        title="Zoom out"
        onClick={zoomOut}
        small
      />
    </div>,
    toolsAnchor,
  );

  return (
    <>
      {svgPortal}
      {toolsPortal}
      {zoomPortal}
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
  small = false,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  activeColor?: string;
  small?: boolean;
}): React.JSX.Element {
  const size = small ? 'h-7 w-7' : 'h-10 w-10';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={
        `flex ${size} items-center justify-center rounded-full border shadow-[0_4px_12px_rgba(42,36,30,0.12)] transition hover:scale-105 ` +
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
