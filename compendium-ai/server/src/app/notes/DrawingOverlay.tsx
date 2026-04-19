'use client';

// Multiplayer freehand drawing on the note body. Strokes live in a
// Y.Array on the per-note HocuspocusProvider so every viewer sees the
// same canvas; coordinates are normalised to the note-main scroll
// host's scrollWidth/scrollHeight so strokes stay anchored to the
// document regardless of anyone's scroll or viewport width.
//
// Ownership: each stroke carries the author's userId. Eraser only
// removes strokes you authored (by-id filter in the Y.Array mutator);
// "Clear all" wipes only your own. You can see everyone else's
// strokes but can't touch them — matches the user's brief.
//
// Controls: three floating circular buttons top-left of the scope
// element (brush / eraser / clear). When the brush is active a
// secondary colour swatch reveals; clicking it opens a native
// <input type="color">.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { Brush, Eraser, Trash2 } from 'lucide-react';

type Stroke = {
  id: string;
  userId: string;
  color: string;
  // Points are fractions of the scope element's scrollWidth /
  // scrollHeight (both in [0, 1]). Converted to pixels at render.
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
const ERASER_RADIUS = 0.012; // fraction of the scope; ~10px at 800px wide

export function DrawingOverlay({
  provider,
  user,
  scopeElementId = 'note-main',
}: {
  provider: HocuspocusProvider;
  user: { userId: string };
  scopeElementId?: string;
}): React.JSX.Element | null {
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [mode, setMode] = useState<Mode>('none');
  const [color, setColor] = useState<string>(PRESET_COLORS[0]!);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
  const [swatchOpen, setSwatchOpen] = useState<boolean>(false);
  const colorInputRef = useRef<HTMLInputElement>(null);

  const strokesYArray = useMemo(
    () => provider.document.getArray<Stroke>('drawing-strokes'),
    [provider],
  );

  // Resolve scope element (scroll host the drawings sit inside).
  useEffect(() => {
    let raf = 0;
    const tryResolve = (): void => {
      if (typeof document === 'undefined') return;
      const el = document.getElementById(scopeElementId) as HTMLElement | null;
      if (el) {
        setScope(el);
        return;
      }
      raf = requestAnimationFrame(tryResolve);
    };
    tryResolve();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scopeElementId]);

  // Track scope dimensions so the SVG resizes with the document. We
  // size the SVG to scrollWidth/scrollHeight (not just clientHeight)
  // so strokes below the fold render when scrolled into view.
  useEffect(() => {
    if (!scope) return;
    const update = (): void => {
      setDims({ w: scope.scrollWidth, h: scope.scrollHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scope);
    const onScroll = (): void => update();
    scope.addEventListener('scroll', onScroll);
    window.addEventListener('resize', onScroll);
    return () => {
      ro.disconnect();
      scope.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [scope]);

  // Observe the shared Y.Array — any remote add / delete reflows our
  // local snapshot. Local commits write through the same array so we
  // pick up our own changes too.
  useEffect(() => {
    const apply = (): void => {
      setStrokes(strokesYArray.toArray().slice());
    };
    apply();
    strokesYArray.observe(apply);
    return () => strokesYArray.unobserve(apply);
  }, [strokesYArray]);

  // Convert viewport coords to scope-local normalised fractions.
  const coordsFromEvent = useCallback(
    (e: PointerEvent | React.PointerEvent): [number, number] | null => {
      if (!scope) return null;
      const rect = scope.getBoundingClientRect();
      const w = scope.scrollWidth;
      const h = scope.scrollHeight;
      if (w <= 0 || h <= 0) return null;
      const x = (e.clientX - rect.left + scope.scrollLeft) / w;
      const y = (e.clientY - rect.top + scope.scrollTop) / h;
      return [clamp01(x), clamp01(y)];
    },
    [scope],
  );

  // Start a brush stroke on pointerdown.
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
        setCurrentStroke(stroke);
      } else if (mode === 'eraser') {
        eraseAt(strokesYArray, user.userId, pt[0], pt[1]);
      }
    },
    [mode, coordsFromEvent, user.userId, color, strokesYArray],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (mode === 'none') return;
      const pt = coordsFromEvent(e);
      if (!pt) return;
      if (mode === 'brush' && currentStroke) {
        setCurrentStroke((prev) => {
          if (!prev) return prev;
          // Drop duplicate consecutive points to keep the array lean.
          const last = prev.points[prev.points.length - 1];
          if (last && last[0] === pt[0] && last[1] === pt[1]) return prev;
          return { ...prev, points: [...prev.points, pt] };
        });
      } else if (mode === 'eraser' && (e.buttons & 1) === 1) {
        eraseAt(strokesYArray, user.userId, pt[0], pt[1]);
      }
    },
    [mode, coordsFromEvent, currentStroke, user.userId, strokesYArray],
  );

  const onPointerUp = useCallback(() => {
    if (currentStroke && currentStroke.points.length > 1) {
      strokesYArray.push([currentStroke]);
    }
    setCurrentStroke(null);
  }, [currentStroke, strokesYArray]);

  const clearMine = useCallback(() => {
    // Delete own strokes highest-index-first so remaining indices
    // stay valid through the loop.
    const mineIndices: number[] = [];
    strokesYArray.forEach((s, i) => {
      if (s.userId === user.userId) mineIndices.push(i);
    });
    mineIndices.reverse();
    for (const i of mineIndices) strokesYArray.delete(i, 1);
    setCurrentStroke(null);
  }, [strokesYArray, user.userId]);

  if (!scope || dims.w === 0 || dims.h === 0) return null;

  const renderable = currentStroke
    ? [...strokes.filter((s) => s.id !== currentStroke.id), currentStroke]
    : strokes;

  return createPortal(
    <>
      <svg
        aria-label="Drawings"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute inset-0"
        style={{
          width: dims.w,
          height: dims.h,
          pointerEvents: mode === 'none' ? 'none' : 'auto',
          cursor: mode === 'brush' ? 'crosshair' : mode === 'eraser' ? 'cell' : 'auto',
          zIndex: 4,
        }}
        viewBox={`0 0 ${dims.w} ${dims.h}`}
      >
        {renderable.map((s) => (
          <polyline
            key={s.id}
            points={s.points.map(([x, y]) => `${x * dims.w},${y * dims.h}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.9}
          />
        ))}
      </svg>

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
}

function eraseAt(
  strokesYArray: Y.Array<Stroke>,
  userId: string,
  x: number,
  y: number,
): void {
  // Collect own-stroke indices whose points pass within the eraser
  // radius of (x, y). Delete in reverse index order so the remaining
  // indices stay valid through the loop.
  const toDelete: number[] = [];
  strokesYArray.forEach((s, i) => {
    if (s.userId !== userId) return;
    for (const [px, py] of s.points) {
      if (Math.hypot(px - x, py - y) <= ERASER_RADIUS) {
        toDelete.push(i);
        break;
      }
    }
  });
  if (toDelete.length === 0) return;
  toDelete.reverse();
  for (const i of toDelete) strokesYArray.delete(i, 1);
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

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
