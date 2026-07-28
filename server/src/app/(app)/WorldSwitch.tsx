'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { EVENTS, identify, setWorld, track } from '@/lib/analytics/client';

type WorldSwitchContextValue = {
  isPending: boolean;
  switchTo: (id: string, destination?: string) => Promise<boolean>;
};

const WorldSwitchContext = createContext<WorldSwitchContextValue | null>(null);

export function WorldSwitchProvider({
  csrfToken,
  activeWorldId,
  userId,
  username,
  children,
}: {
  csrfToken: string;
  activeWorldId?: string;
  userId?: string;
  username?: string;
  children: ReactNode;
}): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isSwitching, setIsSwitching] = useState<boolean>(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDestRef = useRef<string>('/home');
  const lastReportedWorldRef = useRef<string | null>(null);
  const lastIdentifiedUserRef = useRef<string | null>(null);

  // Stitch the anonymous posthog-js distinct_id to the authenticated
  // user on first mount of an authenticated route. posthog-js aliases
  // the pre-login events onto the same Person as everything captured
  // server-side against user.id, so the funnel (page view → signup →
  // verify → first load) lives on one timeline. Without this the
  // anonymous session and the user.id Person stay split.
  useEffect(() => {
    if (!userId) return;
    if (lastIdentifiedUserRef.current === userId) return;
    lastIdentifiedUserRef.current = userId;
    identify(userId, username ? { username } : undefined);
  }, [userId, username]);

  // Keep PostHog group-analytics in sync with the active world. Fires
  // once on mount and again whenever the layout re-renders with a new
  // currentGroupId — no event if nothing changed.
  useEffect(() => {
    if (!activeWorldId) return;
    if (lastReportedWorldRef.current === activeWorldId) return;
    lastReportedWorldRef.current = activeWorldId;
    setWorld(activeWorldId);
    track(EVENTS.WORLD_SELECTED, { world_id: activeWorldId });
  }, [activeWorldId]);

  // Client-side switch. The active world lives in the session row on
  // the server; PATCH /api/worlds/active flips it, then we router-nav
  // home and ask the App Router to re-render the (app) segment.
  //
  // Why not a full reload? The WorldsSidebar is a client component
  // that fetches its icon list on mount — a hard reload would blank
  // the rail and pop the icons back in one by one. Staying on the
  // client keeps the sidebar mounted, so only the highlight pill
  // moves while the main pane swaps.
  //
  // What's important for this to actually look like a switch:
  //   - `(app)/layout.tsx` + `(app)/page.tsx` are `force-dynamic`, so
  //     `router.refresh()` re-reads the session cookie and produces a
  //     new RSC payload with the new `session.currentGroupId`.
  //   - `WorldsSidebar` derives the active highlight from its
  //     `worldId` prop (fed from that same session), NOT from the
  //     `isActive` flag on its mount-time fetch. If it reads isActive
  //     from the local list, the highlight lags by one switch even
  //     though the page content has refreshed — which was the bug.
  const switchTo = useCallback(
    // Default destination is /home (the world's overview) directly, NOT
    // '/'. Routing through '/' triggers page.tsx's `redirect('/home')`
    // server action during the post-switch `router.refresh()`, which
    // clobbers any client navigation the user made between switching
    // and that RSC payload finishing — e.g. clicking a note in the
    // sidebar would briefly load it then snap back to /home.
    async (id: string, destination: string = '/home'): Promise<boolean> => {
      if (isPending || isSwitching) return false;
      setIsSwitching(true);
      try {
        const res = await fetch('/api/worlds/active', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) return false;
        pendingDestRef.current = destination;
        startTransition(() => {
          router.replace(destination);
          router.refresh();
        });
        // Safety net: if router.refresh() hangs (slow server, Railway cold
        // start), isPending stays true forever. Fall back to a hard reload
        // after 8 s so the overlay never traps the user.
        fallbackTimerRef.current = setTimeout(() => {
          window.location.replace(destination);
        }, 8000);
        return true;
      } catch {
        return false;
      } finally {
        setIsSwitching(false);
      }
    },
    [csrfToken, isPending, isSwitching, router],
  );

  // Clear the fallback timer once the transition resolves normally.
  useEffect(() => {
    if (!isPending && fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, [isPending]);

  const value = useMemo<WorldSwitchContextValue>(
    () => ({ isPending: isPending || isSwitching, switchTo }),
    [isPending, isSwitching, switchTo],
  );

  return (
    <WorldSwitchContext.Provider value={value}>{children}</WorldSwitchContext.Provider>
  );
}

export function useWorldSwitch(): WorldSwitchContextValue {
  const ctx = useContext(WorldSwitchContext);
  if (!ctx) {
    throw new Error('useWorldSwitch must be used within WorldSwitchProvider');
  }
  return ctx;
}

export function WorldSwitchOverlay(): React.JSX.Element {
  const { isPending } = useWorldSwitch();
  return (
    <div
      aria-hidden={!isPending}
      className={
        'pointer-events-none absolute inset-0 z-40 flex items-center justify-center transition-opacity duration-150 ' +
        (isPending ? 'opacity-100' : 'opacity-0')
      }
    >
      <div className="absolute inset-0 bg-[var(--parchment)]/60 backdrop-blur-[1px]" />
      <div className="relative rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)]/95 px-4 py-2 shadow-[0_8px_24px_rgb(var(--ink-rgb) / 0.15)]">
        <div className="flex items-center gap-2 text-sm text-[var(--ink-soft)]">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--candlelight)] border-t-transparent" />
          <span style={{ fontFamily: '"Fraunces", Georgia, serif' }}>Switching worlds…</span>
        </div>
      </div>
    </div>
  );
}
