'use client';

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const COOKIE_KEY = 'compendium_sidebar_open';
const WIDTH = 260;

export function CollapsibleSidebar({
  children,
  initialOpen,
}: {
  children: React.ReactNode;
  initialOpen: boolean;
}): React.JSX.Element {
  // Server passes the correct initial value from the cookie — no hydration mismatch.
  const [open, setOpen] = useState(initialOpen);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      // Write cookie so server can read the correct value on next SSR load.
      document.cookie = `${COOKIE_KEY}=${next}; path=/; max-age=31536000; SameSite=Lax`;
      return next;
    });
  }

  return (
    <div
      className="relative hidden h-full shrink-0 md:block"
      style={{
        width: open ? WIDTH : 0,
        transition: ready ? 'width 200ms ease-in-out' : 'none',
      }}
    >
      {/* Overflow-hidden clipping container — prevents the panel from sliding
          over the WorldsSidebar during the open animation. Sibling of the
          toggle tab so the tab is never clipped. */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 flex h-full flex-col bg-[var(--parchment-sunk)]/60"
          style={{
            width: WIDTH,
            transform: open ? 'translateX(0)' : `translateX(-${WIDTH}px)`,
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
        title={open ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
        className="absolute right-0 top-[72px] z-20 flex h-8 w-3 translate-x-full items-center justify-center rounded-r-[4px] border border-l-0 border-[var(--rule)] bg-[var(--parchment-sunk)] text-[var(--ink-muted)] transition hover:bg-[var(--rule)] hover:text-[var(--ink)]"
      >
        {open ? <ChevronLeft size={10} /> : <ChevronRight size={10} />}
      </button>
    </div>
  );
}
