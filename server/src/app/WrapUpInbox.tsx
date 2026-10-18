'use client';

// Header notice for Wrap-up proposals waiting for review in this World
// (a Player's Claude submits them over MCP). A scroll button with a count
// badge; its menu links each Session straight into the review dialog.
// Polls while the tab is visible, like UpdateToast.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollText } from 'lucide-react';
import type { PendingWrapUp } from '@/lib/wrap-up';
import { pendingSummary, reviewHref, WRAP_UP_CHANGED_EVENT } from './wrap-up-inbox';

const POLL_INTERVAL_MS = 60_000;

export function WrapUpInbox({ initial }: { initial: PendingWrapUp[] }): React.JSX.Element | null {
  const [pending, setPending] = useState(initial);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const latest = useRef(0);

  // A server re-render (router.refresh) brings a fresher list.
  useEffect(() => setPending(initial), [initial]);

  const refresh = useCallback(async (): Promise<void> => {
    const ticket = ++latest.current;
    try {
      const res = await fetch('/api/sessions/wrap-up/pending', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { pending?: PendingWrapUp[] };
      // Only the newest request may write, so a slow poll can't undo a fresh one.
      if (ticket === latest.current && Array.isArray(body.pending)) setPending(body.pending);
    } catch {
      // Offline or mid-deploy: keep what we have, the next poll retries.
    }
  }, []);

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (id == null) id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };
    const stop = (): void => {
      if (id != null) clearInterval(id);
      id = null;
    };
    if (document.visibilityState === 'visible') start();
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };
    const onChanged = (): void => void refresh();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onChanged);
    window.addEventListener(WRAP_UP_CHANGED_EVENT, onChanged);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onChanged);
      window.removeEventListener(WRAP_UP_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);

  // Close on navigation (picking an entry), outside click and Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (pending.length === 0) return null;
  const label = `${pending.length} Wrap-up${pending.length === 1 ? '' : 's'} ready to review`;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative flex h-8 items-center gap-1.5 rounded-[8px] bg-[rgb(var(--wine-rgb)/0.1)] px-2.5 text-xs font-medium text-[var(--wine)] transition hover:bg-[rgb(var(--wine-rgb)/0.18)] active:scale-[0.97]"
      >
        <ScrollText size={14} aria-hidden />
        <span className="hidden sm:inline">Wrap-up ready</span>
        <span
          aria-hidden
          className="grid h-4 min-w-4 place-items-center rounded-full bg-[var(--wine)] px-1 text-[10px] font-semibold leading-none text-[var(--wu-on-wine)]"
        >
          {pending.length}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Wrap-ups ready to review"
          className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_8px_24px_rgb(var(--ink-rgb)/0.18)]"
        >
          <p className="border-b border-[var(--rule)] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-soft)]">
            Ready to review
          </p>
          <ul className="max-h-80 overflow-y-auto py-1">
            {pending.map((p) => (
              <li key={p.sessionPath}>
                <Link
                  role="menuitem"
                  href={reviewHref(p.sessionPath)}
                  onClick={() => setOpen(false)}
                  className="block px-3 py-2 transition hover:bg-[var(--parchment)]"
                >
                  <span className="block truncate text-sm font-medium text-[var(--ink)]">
                    Wrap-up for {p.title}
                  </span>
                  <span className="block text-xs text-[var(--ink-soft)]">
                    {pendingSummary(p)} · {formatAgo(p.generatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ts).toLocaleDateString();
}
