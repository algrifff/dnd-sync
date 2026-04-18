'use client';

// Remote mouse pointers layered over the note body. Coordinates are
// *document-relative* (fractions of scrollWidth/scrollHeight) so a
// remote peer pointing at "line 30" stays visually anchored to line 30
// regardless of how either of us has scrolled. When a remote pointer
// sits outside the current viewport, an edge chip renders at the
// scroll host's top or bottom; clicking it scrolls the pointer into
// view.

import { useEffect, useMemo, useState } from 'react';
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
  containerRef,
  user,
  scrollHostId = 'note-main',
}: {
  provider: HocuspocusProvider;
  containerRef: React.RefObject<HTMLElement | null>;
  user: { userId: string; name: string; color: string };
  scrollHostId?: string;
}): React.JSX.Element {
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [tick, setTick] = useState<number>(0); // bump on scroll/resize to re-evaluate visibility

  // Make sure awareness carries our identity — CollaborationCaret sets
  // this when mounted, but viewers don't mount it, and we still want
  // their pointer to be labelled for peers.
  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return;
    aw.setLocalStateField('user', {
      userId: user.userId,
      name: user.name,
      color: user.color,
    });
  }, [provider, user.userId, user.name, user.color]);

  // Broadcast local pointer, rAF-throttled.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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
      const rect = el.getBoundingClientRect();
      const w = el.scrollWidth;
      const h = el.scrollHeight;
      if (w <= 0 || h <= 0) return;
      const xInside = e.clientX - rect.left;
      const yInside = e.clientY - rect.top;
      last = {
        xRel: clamp01(xInside / w),
        yRel: clamp01(yInside / h),
      };
      if (!rafHandle) rafHandle = requestAnimationFrame(flush);
    };
    const onLeave = (): void => {
      last = null;
      aw.setLocalStateField('pointer', null);
    };
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      if (rafHandle) cancelAnimationFrame(rafHandle);
      aw.setLocalStateField('pointer', null);
    };
  }, [provider, containerRef]);

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
  // current viewport. The actual pointer positions are CSS-driven and
  // don't need this — but visibility does.
  useEffect(() => {
    const host = document.getElementById(scrollHostId) ?? document.scrollingElement;
    const bump = (): void => setTick((t) => t + 1);
    host?.addEventListener('scroll', bump);
    window.addEventListener('resize', bump);
    return () => {
      host?.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
    };
  }, [scrollHostId]);

  // Invisible marker: `tick` is read here purely to trigger re-renders
  // so eslint/react-hooks doesn't flag the dep as unused.
  void tick;

  const scrollHost = useMemo(
    () =>
      typeof document === 'undefined'
        ? null
        : (document.getElementById(scrollHostId) as HTMLElement | null),
    [scrollHostId, tick],
  );

  const container = containerRef.current;
  const contentW = container?.scrollWidth ?? 0;
  const contentH = container?.scrollHeight ?? 0;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 5 }}
    >
      {remotes.map((r) => {
        const xAbs = r.xRel * contentW;
        const yAbs = r.yRel * contentH;
        const visibility = classify(container, scrollHost, yAbs);
        if (visibility === 'visible' || !scrollHost) {
          return (
            <PointerDot
              key={r.clientId}
              xAbs={xAbs}
              yAbs={yAbs}
              color={r.color}
              name={r.name}
            />
          );
        }
        return (
          <EdgeChip
            key={r.clientId}
            direction={visibility}
            color={r.color}
            name={r.name}
            onClick={() => scrollIntoView(scrollHost, container, yAbs)}
          />
        );
      })}
    </div>
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
      className="absolute flex -translate-x-0 -translate-y-0 items-start gap-1"
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
  onClick,
}: {
  direction: 'above' | 'below';
  color: string;
  name: string;
  onClick: () => void;
}): React.JSX.Element {
  const arrow = direction === 'above' ? '↑' : '↓';
  return (
    <button
      type="button"
      onClick={onClick}
      className="pointer-events-auto absolute left-1/2 -translate-x-1/2 rounded-full border px-2 py-0.5 text-[10px] font-medium text-[#2A241E] shadow-[0_4px_12px_rgba(42,36,30,0.12)] transition hover:scale-[1.03]"
      style={{
        [direction === 'above' ? 'top' : 'bottom']: 8,
        backgroundColor: '#FBF5E8',
        borderColor: color,
      }}
    >
      <span aria-hidden className="mr-1" style={{ color }}>
        {arrow}
      </span>
      {name}
    </button>
  );
}

// Is the pointer's y-position inside the scroll host's current viewport?
function classify(
  container: HTMLElement | null,
  scrollHost: HTMLElement | null,
  yAbsInContainer: number,
): 'above' | 'below' | 'visible' {
  if (!container || !scrollHost) return 'visible';
  const cRect = container.getBoundingClientRect();
  const hRect = scrollHost.getBoundingClientRect();
  // Pointer's screen-Y:
  const screenY = cRect.top + yAbsInContainer;
  if (screenY < hRect.top) return 'above';
  if (screenY > hRect.bottom) return 'below';
  return 'visible';
}

function scrollIntoView(
  scrollHost: HTMLElement,
  container: HTMLElement | null,
  yAbsInContainer: number,
): void {
  if (!container) return;
  const cRect = container.getBoundingClientRect();
  const hRect = scrollHost.getBoundingClientRect();
  // Target scrollTop that places the pointer roughly 30% down the viewport.
  const offsetInHost = cRect.top - hRect.top + scrollHost.scrollTop + yAbsInContainer;
  scrollHost.scrollTo({
    top: Math.max(0, offsetInHost - scrollHost.clientHeight * 0.3),
    behavior: 'smooth',
  });
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
