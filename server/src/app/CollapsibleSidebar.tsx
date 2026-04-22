'use client';

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const STORAGE_KEY = 'compendium_sidebar_open';
const WIDTH = 260;

export function CollapsibleSidebar({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'false') setOpen(false);
    // Enable transitions only after the initial closed state is committed —
    // otherwise the sidebar animates closed on every page navigation.
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  // Avoid layout flash on first render — match server (open=true)
  const effectiveOpen = !mounted || open;

  return (
    <div
      className="relative hidden h-full shrink-0 md:block"
      style={{
        width: effectiveOpen ? WIDTH : 0,
        transition: mounted ? 'width 200ms ease-in-out' : 'none',
      }}
    >
      {/* Sliding panel — visibility:hidden when closed so clipped content
          doesn't bleed as a ghost overlay over the note area */}
      <div
        className="absolute inset-y-0 left-0 flex h-full flex-col bg-[#EAE1CF]/60"
        style={{
          width: WIDTH,
          transform: effectiveOpen ? 'translateX(0)' : `translateX(-${WIDTH}px)`,
          transition: mounted ? 'transform 200ms ease-in-out' : 'none',
          visibility: effectiveOpen ? 'visible' : 'hidden',
        }}
      >
        {children}
      </div>

      {/* Toggle tab — lives outside the overflow:hidden panel so it always
          peeks out at the right edge. visibility:visible overrides the
          parent's hidden state when the sidebar is collapsed. */}
      <button
        onClick={toggle}
        title={effectiveOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-label={effectiveOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        style={{ visibility: 'visible' }}
        className="absolute right-0 top-[72px] z-20 flex h-8 w-3 translate-x-full items-center justify-center rounded-r-[4px] border border-l-0 border-[#D4C7AE] bg-[#EAE1CF] text-[#8A7E6B] transition hover:bg-[#D4C7AE] hover:text-[#2A241E]"
      >
        {effectiveOpen ? <ChevronLeft size={10} /> : <ChevronRight size={10} />}
      </button>
    </div>
  );
}
