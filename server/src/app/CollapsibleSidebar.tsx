'use client';

import { useState, useLayoutEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const STORAGE_KEY = 'compendium_sidebar_open';
const WIDTH = 260;

export function CollapsibleSidebar({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [ready, setReady] = useState(false);

  // useLayoutEffect fires synchronously before the browser paints, so the
  // correct closed state is applied before the first frame — no pop-in flash.
  useLayoutEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'false') setOpen(false);
    setReady(true);
  }, []);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  // Before the layout effect runs (SSR / first hydration) render as open so
  // no hydration mismatch — useLayoutEffect corrects it before paint.
  const effectiveOpen = !ready || open;

  return (
    <div
      className="relative hidden h-full shrink-0 md:block"
      style={{
        width: effectiveOpen ? WIDTH : 0,
        transition: ready ? 'width 200ms ease-in-out' : 'none',
      }}
    >
      {/* Overflow-hidden clipping container — prevents the panel from sliding
          over the WorldsSidebar during the open animation. Sibling of the
          toggle tab so the tab is never clipped. */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 flex h-full flex-col bg-[#EAE1CF]/60"
          style={{
            width: WIDTH,
            transform: effectiveOpen ? 'translateX(0)' : `translateX(-${WIDTH}px)`,
            transition: ready ? 'transform 200ms ease-in-out' : 'none',
          }}
        >
          {children}
        </div>
      </div>

      {/* Toggle tab — sibling of the overflow:hidden container so it's never
          clipped. Sits at the right edge and peeks out via translate-x-full. */}
      <button
        onClick={toggle}
        title={effectiveOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-label={effectiveOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        className="absolute right-0 top-[72px] z-20 flex h-8 w-3 translate-x-full items-center justify-center rounded-r-[4px] border border-l-0 border-[#D4C7AE] bg-[#EAE1CF] text-[#8A7E6B] transition hover:bg-[#D4C7AE] hover:text-[#2A241E]"
      >
        {effectiveOpen ? <ChevronLeft size={10} /> : <ChevronRight size={10} />}
      </button>
    </div>
  );
}
