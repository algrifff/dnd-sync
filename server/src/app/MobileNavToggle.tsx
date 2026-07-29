'use client';

// Hamburger trigger for the mobile navigation drawer. Hidden at `md`
// and above, where the always-visible WorldsSidebar rail and
// CollapsibleSidebar file tree already cover this job.

import { Menu, X } from 'lucide-react';
import { useMobileNav } from './MobileNavContext';

export function MobileNavToggle(): React.JSX.Element | null {
  const nav = useMobileNav();
  // No MobileNavProvider ancestor (e.g. the settings layout) — render
  // nothing rather than a dead button.
  if (!nav) return null;
  const { open, setOpen, triggerRef } = nav;

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen(!open)}
      title={open ? 'Close navigation' : 'Open navigation'}
      aria-label={open ? 'Close navigation' : 'Open navigation'}
      aria-expanded={open}
      aria-controls="mobile-nav-drawer"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/20 hover:text-[var(--ink)] md:hidden"
    >
      {open ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
    </button>
  );
}
