'use client';

import { useState, useLayoutEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const STORAGE_KEY = 'compendium_rightpanel_open';
const WIDTH = 280;

export function CollapsibleRightPanel({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [ready, setReady] = useState(false);

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

  const effectiveOpen = !ready || open;

  return (
    <div
      className="relative hidden shrink-0 md:block"
      style={{
        width: effectiveOpen ? WIDTH : 0,
        transition: ready ? 'width 200ms ease-in-out' : 'none',
      }}
    >
      {/* Overflow-hidden clipping container — sibling of toggle tab */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-y-0 right-0 flex h-full flex-col"
          style={{
            width: WIDTH,
            transform: effectiveOpen ? 'translateX(0)' : `translateX(${WIDTH}px)`,
            transition: ready ? 'transform 200ms ease-in-out' : 'none',
          }}
        >
          {children}
        </div>
      </div>

      {/* Toggle tab — sibling of the overflow:hidden container */}
      <button
        onClick={toggle}
        title={effectiveOpen ? 'Collapse panel' : 'Expand panel'}
        aria-label={effectiveOpen ? 'Collapse panel' : 'Expand panel'}
        className="absolute left-0 top-[72px] z-20 flex h-8 w-3 -translate-x-full items-center justify-center rounded-l-[4px] border border-r-0 border-[#D4C7AE] bg-[#EAE1CF] text-[#8A7E6B] transition hover:bg-[#D4C7AE] hover:text-[#2A241E]"
      >
        {effectiveOpen ? <ChevronRight size={10} /> : <ChevronLeft size={10} />}
      </button>
    </div>
  );
}
