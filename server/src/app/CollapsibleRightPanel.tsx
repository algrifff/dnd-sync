'use client';

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const STORAGE_KEY = 'compendium_rightpanel_open';
const WIDTH = 280;

export function CollapsibleRightPanel({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'false') setOpen(false);
    setMounted(true);
  }, []);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  const effectiveOpen = !mounted || open;

  return (
    <div
      className="relative hidden shrink-0 md:block"
      style={{
        width: effectiveOpen ? WIDTH : 0,
        transition: mounted ? 'width 200ms ease-in-out' : 'none',
        // Ensure the toggle tab can overflow the boundary
        overflow: 'visible',
      }}
    >
      {/* Sliding panel */}
      <div
        className="absolute inset-y-0 right-0 h-full overflow-hidden"
        style={{
          width: WIDTH,
          transform: effectiveOpen ? 'translateX(0)' : `translateX(${WIDTH}px)`,
          transition: mounted ? 'transform 200ms ease-in-out' : 'none',
        }}
      >
        {children}
      </div>

      {/* Toggle tab — always visible at the left boundary */}
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
