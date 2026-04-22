'use client';

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const STORAGE_KEY = 'compendium_sidebar_open';
const WIDTH = 260;

function readOpen(): boolean {
  // typeof window guard: returns false during SSR, correct value on client.
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

export function CollapsibleSidebar({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  // Lazy initializer reads localStorage on the first client render so the
  // component starts with the correct state — no correction pass needed.
  const [open, setOpen] = useState(readOpen);
  const [ready, setReady] = useState(false);

  // Enable transitions only after the initial state is painted.
  useEffect(() => {
    setReady(true);
  }, []);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <div
      suppressHydrationWarning
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
          suppressHydrationWarning
          className="absolute inset-y-0 left-0 flex h-full flex-col bg-[#EAE1CF]/60"
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
        className="absolute right-0 top-[72px] z-20 flex h-8 w-3 translate-x-full items-center justify-center rounded-r-[4px] border border-l-0 border-[#D4C7AE] bg-[#EAE1CF] text-[#8A7E6B] transition hover:bg-[#D4C7AE] hover:text-[#2A241E]"
      >
        {open ? <ChevronLeft size={10} /> : <ChevronRight size={10} />}
      </button>
    </div>
  );
}
