'use client';

// Remote mouse pointers layered over collaborative content.
//
// Two coordinate modes are supported:
//
//  * Virtual-pixel mode (notes): pass `virtualWidth` and the fixed-
//    width content column id. The coord scope is the column (same
//    width on every peer), so pointer x/y stored as virtual-px line
//    up exactly with drawing strokes stored in the same space. Dots
//    portal into the column and inherit its CSS zoom so they scale
//    with the drawings.
//
//  * Fraction mode (graph canvas): no `virtualWidth`. Coordinates
//    are stored as fractions of the scope's scrollWidth/scrollHeight,
//    which is how the original overlay worked. Still handy for
//    rendering pointers on screens with no fixed-width anchor (the
//    graph container fills the viewport at whatever size).
//
// The outer viewport scope is used to listen for moves (so the
// whole main column is active) and to anchor edge chips when a peer
// has scrolled out of view.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HocuspocusProvider } from '@hocuspocus/provider';

type VirtualPointer = { x: number; y: number };
type FractionPointer = { xRel: number; yRel: number };

type Remote = {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  // In virtual mode these are virtual-px; in fraction mode, 0..1.
  x: number;
  y: number;
  cursorMode: 'color' | 'image';
  avatarVersion: number;
};

export function PointerOverlay({
  provider,
  user,
  coordScopeId,
  viewportScopeId,
  scopeElementId,
  virtualWidth,
}: {
  provider: HocuspocusProvider;
  user: {
    userId: string;
    name: string;
    color: string;
    cursorMode?: 'color' | 'image';
    avatarVersion?: number;
  };
  /** Element whose local coord space we broadcast in. Defaults to the
   *  fixed-width note column in virtual mode. */
  coordScopeId?: string;
  /** Element that scrolls around the coord scope. Defaults to the
   *  note's `note-main`. */
  viewportScopeId?: string;
  /** Legacy single-scope prop — if given, used for both coord and
   *  viewport. Kept for callers that haven't migrated to the two-
   *  scope API (e.g. the graph canvas). */
  scopeElementId?: string;
  /** Presence of this prop flips on virtual-pixel mode. */
  virtualWidth?: number;
}): React.JSX.Element | null {
  const resolvedCoordId = coordScopeId ?? scopeElementId ?? 'note-scroll-body';
  const resolvedViewportId =
    viewportScopeId ?? scopeElementId ?? 'note-main';

  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [coordScope, setCoordScope] = useState<HTMLElement | null>(null);
  const [viewportScope, setViewportScope] = useState<HTMLElement | null>(null);
  const [, bumpTick] = useState<number>(0);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let raf = 0;
    const tryResolve = (): void => {
      const cs = document.getElementById(resolvedCoordId) as HTMLElement | null;
      const vs = document.getElementById(resolvedViewportId) as HTMLElement | null;
      if (cs) {
        setCoordScope(cs);
        setViewportScope(vs ?? cs);
        return;
      }
      raf = requestAnimationFrame(tryResolve);
    };
    tryResolve();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [resolvedCoordId, resolvedViewportId]);

  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return;
    aw.setLocalStateField('user', {
      userId: user.userId,
      name: user.name,
      color: user.color,
      cursorMode: user.cursorMode ?? 'color',
      avatarVersion: user.avatarVersion ?? 0,
    });
  }, [
    provider,
    user.userId,
    user.name,
    user.color,
    user.cursorMode,
    user.avatarVersion,
  ]);

  // Broadcast local pointer. Listen on the viewport scope so moves
  // anywhere in the column register, but convert into the coord
  // scope's local space.
  useEffect(() => {
    const listenEl = viewportScope ?? coordScope;
    if (!listenEl || !coordScope) return;
    const aw = provider.awareness;
    if (!aw) return;

    let rafHandle = 0;
    let last: VirtualPointer | FractionPointer | null = null;

    const flush = (): void => {
      rafHandle = 0;
      if (!last) return;
      aw.setLocalStateField('pointer', last);
    };
    const onMove = (e: MouseEvent): void => {
      if (virtualWidth) {
        const rect = coordScope.getBoundingClientRect();
        if (rect.width <= 0) return;
        const scale = rect.width / virtualWidth;
        last = {
          x: (e.clientX - rect.left) / scale,
          y: (e.clientY - rect.top) / scale,
        };
      } else {
        const rect = coordScope.getBoundingClientRect();
        const w = coordScope.scrollWidth;
        const h = coordScope.scrollHeight;
        if (w <= 0 || h <= 0) return;
        const xInside = e.clientX - rect.left + coordScope.scrollLeft;
        const yInside = e.clientY - rect.top + coordScope.scrollTop;
        last = { xRel: clamp01(xInside / w), yRel: clamp01(yInside / h) };
      }
      if (!rafHandle) rafHandle = requestAnimationFrame(flush);
    };
    const onLeave = (): void => {
      last = null;
      aw.setLocalStateField('pointer', null);
    };
    listenEl.addEventListener('mousemove', onMove);
    listenEl.addEventListener('mouseleave', onLeave);
    return () => {
      listenEl.removeEventListener('mousemove', onMove);
      listenEl.removeEventListener('mouseleave', onLeave);
      if (rafHandle) cancelAnimationFrame(rafHandle);
      aw.setLocalStateField('pointer', null);
    };
  }, [provider, coordScope, viewportScope, virtualWidth]);

  // Read remote awareness, accepting either the virtual-px shape or
  // the fraction shape.
  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return;
    const recompute = (): void => {
      if (!coordScope) return;
      const w = coordScope.scrollWidth;
      const h = coordScope.scrollHeight;
      const states = aw.getStates();
      const list: Remote[] = [];
      for (const [clientId, state] of states.entries()) {
        if (clientId === aw.clientID) continue;
        const s = state as Partial<PeerState> | undefined;
        if (!s?.user || !s.pointer) continue;
        const p = s.pointer;
        let x: number;
        let y: number;
        if (virtualWidth && typeof p.x === 'number' && typeof p.y === 'number') {
          x = p.x;
          y = p.y;
        } else if (
          !virtualWidth &&
          typeof p.xRel === 'number' &&
          typeof p.yRel === 'number'
        ) {
          x = p.xRel * w;
          y = p.yRel * h;
        } else {
          continue;
        }
        list.push({
          clientId,
          userId: s.user.userId ?? '',
          name: s.user.name ?? 'Anonymous',
          color: s.user.color ?? '#5A4F42',
          x,
          y,
          cursorMode: s.user.cursorMode === 'image' ? 'image' : 'color',
          avatarVersion:
            typeof s.user.avatarVersion === 'number'
              ? s.user.avatarVersion
              : 0,
        });
      }
      setRemotes(list);
    };
    aw.on('change', recompute);
    recompute();
    return () => aw.off('change', recompute);
  }, [provider, coordScope, virtualWidth]);

  // Cache viewport + coord rects for edge-chip positioning. Bump on
  // scroll / resize / content change.
  const viewportRectRef = useRef<DOMRect | null>(null);
  const coordRectRef = useRef<DOMRect | null>(null);
  useEffect(() => {
    if (!viewportScope || !coordScope) return;
    const bump = (): void => {
      viewportRectRef.current = viewportScope.getBoundingClientRect();
      coordRectRef.current = coordScope.getBoundingClientRect();
      bumpTick((t) => t + 1);
    };
    bump();
    viewportScope.addEventListener('scroll', bump);
    window.addEventListener('resize', bump);
    const ro = new ResizeObserver(bump);
    ro.observe(coordScope);
    return () => {
      viewportScope.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
      ro.disconnect();
    };
  }, [viewportScope, coordScope]);

  if (!coordScope || !viewportScope) return null;

  const coordRect = coordRectRef.current;
  const viewportRect = viewportRectRef.current;
  // Effective scale between virtual-px / fraction units and coord
  // scope screen pixels.
  const yScale = virtualWidth
    ? coordRect && coordRect.width > 0
      ? coordRect.width / virtualWidth
      : 1
    : 1;

  // Dots sit inside the coord scope so they scroll with content and
  // inherit any CSS zoom applied there.
  const dotsPortal = createPortal(
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 5 }}
    >
      {remotes.map((r) => (
        <PointerDot
          key={r.clientId}
          x={r.x}
          y={r.y}
          color={r.color}
          name={r.name}
          avatarUrl={
            r.cursorMode === 'image' && r.avatarVersion > 0 && r.userId
              ? `/api/users/${r.userId}/avatar?v=${r.avatarVersion}`
              : null
          }
        />
      ))}
    </div>,
    coordScope,
  );

  // Edge chips live on the viewport scope. We compute each peer's
  // screen y by translating virtual-px through the coord scope's
  // bounding rect.
  const edgeChips =
    viewportRect && coordRect
      ? remotes
          .map((r) => {
            const screenY = coordRect.top + r.y * yScale;
            if (screenY < viewportRect.top + 4) {
              return (
                <EdgeChip
                  key={r.clientId}
                  direction="above"
                  color={r.color}
                  name={r.name}
                  onClick={() => {
                    viewportScope.scrollBy({
                      top: screenY - viewportRect.top - viewportRect.height * 0.3,
                      behavior: 'smooth',
                    });
                  }}
                  top={8}
                />
              );
            }
            if (screenY > viewportRect.bottom - 18) {
              return (
                <EdgeChip
                  key={r.clientId}
                  direction="below"
                  color={r.color}
                  name={r.name}
                  onClick={() => {
                    viewportScope.scrollBy({
                      top: screenY - viewportRect.bottom + viewportRect.height * 0.3,
                      behavior: 'smooth',
                    });
                  }}
                  top={viewportRect.height - 22}
                />
              );
            }
            return null;
          })
          .filter(Boolean)
      : [];

  const edgePortal = createPortal(
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 6 }}
    >
      {edgeChips}
    </div>,
    viewportScope,
  );

  return (
    <>
      {dotsPortal}
      {edgePortal}
    </>
  );
}

type PeerState = {
  user: {
    userId: string;
    name: string;
    color: string;
    cursorMode?: 'color' | 'image';
    avatarVersion?: number;
  };
  pointer?: (Partial<VirtualPointer> & Partial<FractionPointer>) | null;
};

function PointerDot({
  x,
  y,
  color,
  name,
  avatarUrl,
}: {
  x: number;
  y: number;
  color: string;
  name: string;
  avatarUrl: string | null;
}): React.JSX.Element {
  // The triangle pointer is always rendered so peers can tell where
  // the actual cursor tip is. The avatar, when enabled, sits
  // directly above the name label in a second column — it's a badge,
  // not a replacement for the pointer.
  return (
    <div
      className="absolute flex items-start gap-1"
      style={{ left: x, top: y, color }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill={color}
        stroke="#FBF5E8"
        strokeWidth="1"
      >
        <path d="M1 1 L1 11 L4 8 L6.5 13 L8.5 12.2 L6 7.3 L11 7.3 Z" />
      </svg>
      <div className="mt-2 flex flex-col items-start gap-1">
        {avatarUrl && (
          <img
            src={avatarUrl}
            alt=""
            className="h-10 w-10 rounded-full border-2 object-cover shadow-[0_2px_6px_rgba(42,36,30,0.3)]"
            style={{ borderColor: color }}
          />
        )}
        <span
          className="whitespace-nowrap rounded-[4px] px-1 text-[10px] font-medium text-[#2A241E]"
          style={{ backgroundColor: color }}
        >
          {name}
        </span>
      </div>
    </div>
  );
}

function EdgeChip({
  direction,
  color,
  name,
  top,
  onClick,
}: {
  direction: 'above' | 'below';
  color: string;
  name: string;
  top: number;
  onClick: () => void;
}): React.JSX.Element {
  const arrow = direction === 'above' ? '↑' : '↓';
  return (
    <button
      type="button"
      onClick={onClick}
      className="pointer-events-auto absolute left-1/2 -translate-x-1/2 rounded-full border px-2 py-0.5 text-[10px] font-medium text-[#2A241E] shadow-[0_4px_12px_rgba(42,36,30,0.12)] transition hover:scale-[1.03]"
      style={{ top, backgroundColor: '#FBF5E8', borderColor: color }}
    >
      <span aria-hidden className="mr-1" style={{ color }}>
        {arrow}
      </span>
      {name}
    </button>
  );
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
