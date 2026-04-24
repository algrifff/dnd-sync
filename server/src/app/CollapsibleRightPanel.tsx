'use client';

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const COOKIE_KEY = 'compendium_rightpanel_open';
const WIDTH = 280;

export function CollapsibleRightPanel({
  children,
  initialOpen,
}: {
  children: React.ReactNode;
  initialOpen: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      document.cookie = `${COOKIE_KEY}=${next}; path=/; max-age=31536000; SameSite=Lax`;
      return next;
    });
  }

  return (
    <div
      className="relative hidden shrink-0 md:block"
      style={{
        width: open ? WIDTH : 0,
        transition: ready ? 'width 200ms ease-in-out' : 'none',
      }}
    >
      {/* Overflow-hidden clipping container — sibling of toggle tab */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-y-0 right-0 flex h-full flex-col"
          style={{
            width: WIDTH,
            transform: open ? 'translateX(0)' : `translateX(${WIDTH}px)`,
            transition: ready ? 'transform 200ms ease-in-out' : 'none',
          }}
        >
          {children}
        </div>
      </div>

      {/* Toggle tab — sibling of the overflow:hidden container */}
      <button
        onClick={toggle}
        title={open ? 'Collapse panel' : 'Expand panel'}
        aria-label={open ? 'Collapse panel' : 'Expand panel'}
        className="absolute left-0 top-[72px] z-20 flex h-8 w-3 -translate-x-full items-center justify-center rounded-l-[4px] border border-r-0 border-[var(--rule)] bg-[var(--parchment-sunk)] text-[var(--ink-muted)] transition hover:bg-[var(--rule)] hover:text-[var(--ink)]"
      >
        {open ? <ChevronRight size={10} /> : <ChevronLeft size={10} />}
      </button>
    </div>
  );
}
