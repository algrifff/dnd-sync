'use client';

// Remote mouse pointers layered over the note's main content pane. The
// listener attaches to `#note-main` (the scrolling host for note pages)
// and coordinates are normalised to that element's scrollWidth /
// scrollHeight so a remote peer pointing at a document position stays
// anchored there regardless of either peer's scroll.
//
// The overlay DOM is rendered via a Portal into `#note-main` so its
// reach is the full width of the document pane — not just the centred
// article. It deliberately stops at the main column (header and
// sidebars are excluded). When a remote pointer sits outside the
// scroll viewport, an edge chip renders at the top or bottom of main;
// clicking scrolls the pointer into view.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HocuspocusProvider } from '@hocuspocus/provider';

type Remote = {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  xRel: number;
  yRel: number;
};

export function PointerOverlay({
  provider,
  user,
  scopeElementId = 'note-main',
}: {
  provider: HocuspocusProvider;
  user: { userId: string; name: string; color: string };
  scopeElementId?: string;
}): React.JSX.Element | null {
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [tick, setTick] = useState<number>(0); // bump on scroll/resize

  // Resolve the scope element on mount and whenever the node id might
  // change between navigations. Next may swap the DOM in place so
  // poll briefly for the first render.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let raf = 0;
    const tryResolve = (): void => {
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

  // Seed awareness.user — CollaborationCaret also does this for
  // editors, but viewers don't mount it, and we still want their
  // pointer to be labelled for peers.
  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return;
    aw.setLocalStateField('user', {
      userId: user.userId,
      name: user.name,
      color: user.color,
    });
  }, [provider, user.userId, user.name, user.color]);

  // Broadcast local pointer, rAF-throttled. Listener is on the scope
  // element so the full middle column is active, not just the centred
  // article.
  useEffect(() => {
    if (!scope) return;
    const aw = provider.awareness;
    if (!aw) return;

    let rafHandle = 0;
    let last: { xRel: number; yRel: number } | null = null;

    const flush = (): void => {
      rafHandle = 0;
      if (!last) return;
      aw.setLocalStateField('pointer', last);
    };
    const onMove = (e: MouseEvent): void => {
      const rect = scope.getBoundingClientRect();
      const w = scope.scrollWidth;
      const h = scope.scrollHeight;
      if (w <= 0 || h <= 0) return;
      // Convert screen coords to scope-local scroll coords.
      const xInside = e.clientX - rect.left + scope.scrollLeft;
      const yInside = e.clientY - rect.top + scope.scrollTop;
      last = { xRel: clamp01(xInside / w), yRel: clamp01(yInside / h) };
      if (!rafHandle) rafHandle = requestAnimationFrame(flush);
    };
    const onLeave = (): void => {
      last = null;
      aw.setLocalStateField('pointer', null);
    };
    scope.addEventListener('mousemove', onMove);
    scope.addEventListener('mouseleave', onLeave);
    return () => {
      scope.removeEventListener('mousemove', onMove);
      scope.removeEventListener('mouseleave', onLeave);
      if (rafHandle) cancelAnimationFrame(rafHandle);
      aw.setLocalStateField('pointer', null);
    };
  }, [provider, scope]);

  // Read remote awareness.
  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return;
    const recompute = (): void => {
      const states = aw.getStates();
      const list: Remote[] = [];
      for (const [clientId, state] of states.entries()) {
        if (clientId === aw.clientID) continue;
        const s = state as Partial<PeerState> | undefined;
        if (!s?.user || !s.pointer) continue;
        if (typeof s.pointer.xRel !== 'number' || typeof s.pointer.yRel !== 'number') continue;
        list.push({
          clientId,
          userId: s.user.userId ?? '',
          name: s.user.name ?? 'Anonymous',
          color: s.user.color ?? '#5A4F42',
          xRel: s.pointer.xRel,
          yRel: s.pointer.yRel,
        });
      }
      setRemotes(list);
    };
    aw.on('change', recompute);
    recompute();
    return () => aw.off('change', recompute);
  }, [provider]);

  // Rerender on scroll / resize so the edge-chip logic reflects the
  // current viewport.
  useEffect(() => {
    if (!scope) return;
    const bump = (): void => setTick((t) => t + 1);
    scope.addEventListener('scroll', bump);
    window.addEventListener('resize', bump);
    return () => {
      scope.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
    };
  }, [scope]);

  void tick;

  if (!scope) return null;

  const contentW = scope.scrollWidth;
  const contentH = scope.scrollHeight;
  const viewTop = scope.scrollTop;
  const viewBottom = viewTop + scope.clientHeight;

  return createPortal(
    <div aria-hidden className="pointer-events-none absolute inset-0" style={{ zIndex: 5 }}>
      {remotes.map((r) => {
        const xAbs = r.xRel * contentW;
        const yAbs = r.yRel * contentH;
        if (yAbs < viewTop) {
          return (
            <EdgeChip
              key={r.clientId}
              direction="above"
              color={r.color}
              name={r.name}
              onClick={() => scrollTo(scope, yAbs)}
              top={viewTop + 8}
            />
          );
        }
        if (yAbs > viewBottom) {
          return (
            <EdgeChip
              key={r.clientId}
              direction="below"
              color={r.color}
              name={r.name}
              onClick={() => scrollTo(scope, yAbs)}
              top={viewBottom - 22}
            />
          );
        }
        return (
          <PointerDot key={r.clientId} xAbs={xAbs} yAbs={yAbs} color={r.color} name={r.name} />
        );
      })}
    </div>,
    scope,
  );
}

type PeerState = {
  user: { userId: string; name: string; color: string };
  pointer?: { xRel: number; yRel: number } | null;
};

function PointerDot({
  xAbs,
  yAbs,
  color,
  name,
}: {
  xAbs: number;
  yAbs: number;
  color: string;
  name: string;
}): React.JSX.Element {
  return (
    <div
      className="absolute flex items-start gap-1"
      style={{ left: xAbs, top: yAbs, color }}
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
      <span
        className="mt-2 whitespace-nowrap rounded-[4px] px-1 text-[10px] font-medium text-[#2A241E]"
        style={{ backgroundColor: color }}
      >
        {name}
      </span>
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

function scrollTo(scope: HTMLElement, yAbs: number): void {
  scope.scrollTo({
    top: Math.max(0, yAbs - scope.clientHeight * 0.3),
    behavior: 'smooth',
  });
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
