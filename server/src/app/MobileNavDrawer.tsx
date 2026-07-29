'use client';

// The mobile navigation drawer: a slide-in panel below `md` that
// surfaces the world switcher and the file tree, neither of which has
// any other way to reach a phone-width viewport (both WorldsSidebar
// and CollapsibleSidebar are `hidden ... md:flex/block`).
//
// Reuse, not a fork: the world-switcher content is the *same*
// `<WorldsSidebar>` component the desktop rail renders — just with
// `variant="drawer"` so its outer element is a plain flex column
// instead of `hidden ... md:flex` (see WorldsSidebar.tsx). The file
// tree body is passed in as `children` — ContentLayout builds that
// JSX once and hands the identical element to both the desktop
// CollapsibleSidebar and this drawer, so there is exactly one place
// that assembles the tree markup and no way for the two to drift.
//
// Both copies are real, independently-mounted component instances
// (this isn't a portal), but the WorldsSidebar one only mounts while
// the drawer is open, so a user who never opens the drawer never pays
// for a second `/api/worlds` fetch.

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { useMobileNav } from './MobileNavContext';
import { WorldsSidebar } from './WorldsSidebar';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function MobileNavDrawer({
  csrfToken,
  userId,
  displayName,
  accentColor,
  avatarVersion,
  role,
  worldId,
  children,
}: {
  csrfToken: string;
  userId: string;
  displayName: string;
  accentColor: string;
  avatarVersion: number;
  role: 'admin' | 'editor' | 'viewer';
  worldId: string;
  /** File-tree sidebar body — the same element passed to the desktop
   *  <CollapsibleSidebar>. Only mounted here while the drawer is open. */
  children: ReactNode;
}): React.JSX.Element | null {
  const nav = useMobileNav();
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const lastPathRef = useRef(pathname);

  const open = nav?.open ?? false;

  // Close on navigation — tapping a note or switching a world should
  // land the user on the new page, not leave the drawer covering it.
  useEffect(() => {
    if (pathname !== lastPathRef.current) {
      lastPathRef.current = pathname;
      nav?.setOpen(false);
    }
  }, [pathname, nav]);

  // Inert the panel while closed: it's translated off-canvas, but
  // without this its (few) always-rendered controls — the close
  // button — would still be reachable via Tab. Also flips focus into
  // the panel on open and restores it to the trigger button on close.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.inert = !open;
    if (open) {
      wasOpenRef.current = true;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      nav?.triggerRef.current?.focus();
    }
  }, [open, nav]);

  // Escape to close, Tab/Shift+Tab trapped inside the panel.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        nav?.setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, nav]);

  if (!nav) return null;

  return (
    <div className="md:hidden">
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={() => nav.setOpen(false)}
        className={
          'fixed inset-0 z-40 bg-[var(--shadow)]/60 transition-opacity duration-200 ease-out motion-reduce:transition-none ' +
          (open ? 'opacity-100' : 'pointer-events-none opacity-0')
        }
      />
      {/* Panel */}
      <div
        id="mobile-nav-drawer"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={
          'fixed inset-y-0 left-0 z-50 flex h-full w-[min(340px,85vw)] shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none ' +
          (open ? 'translate-x-0' : '-translate-x-full')
        }
      >
        <div className="flex h-full w-full flex-row overflow-hidden border-r border-[var(--rule)] bg-[var(--parchment-sunk)] shadow-[0_16px_48px_rgb(var(--ink-rgb)/0.3)]">
          {open && (
            <WorldsSidebar
              variant="drawer"
              csrfToken={csrfToken}
              userId={userId}
              displayName={displayName}
              accentColor={accentColor}
              avatarVersion={avatarVersion}
              role={role}
              worldId={worldId}
            />
          )}
          <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-[var(--parchment-sunk)]/60">
            <div className="flex shrink-0 items-center justify-end px-2 pt-2">
              <button
                type="button"
                onClick={() => nav.setOpen(false)}
                title="Close navigation"
                aria-label="Close navigation"
                className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--ink-soft)] transition hover:bg-[var(--rule)] hover:text-[var(--ink)]"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
            {open && children}
          </div>
        </div>
      </div>
    </div>
  );
}
