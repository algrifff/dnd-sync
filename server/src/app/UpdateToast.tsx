'use client';

import { useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 60_000;

type Health = { commit: string | null; schemaVersion: number };

async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as Health;
    return data;
  } catch {
    return null;
  }
}

function sameVersion(a: Health, b: Health): boolean {
  if (a.commit && b.commit) return a.commit === b.commit;
  return a.schemaVersion === b.schemaVersion;
}

async function hardReload(): Promise<void> {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // ignore — best-effort cache purge
  }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    // ignore
  }
  window.location.reload();
}

export function UpdateToast(): React.ReactElement | null {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let baseline: Health | null = null;

    async function tick(): Promise<void> {
      const current = await fetchHealth();
      if (cancelled || !current) return;
      if (!baseline) {
        baseline = current;
        return;
      }
      if (!sameVersion(baseline, current)) {
        setUpdateAvailable(true);
      }
    }

    void tick();
    const id = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    const onFocus = (): void => {
      void tick();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex justify-end"
    >
      <div className="pointer-events-auto flex max-w-sm items-start gap-3 rounded-lg border border-[var(--rule)] bg-[var(--parchment)] px-4 py-3 text-[var(--ink)] shadow-lg">
        <div className="flex flex-col gap-1">
          <div className="font-serif text-base font-semibold">A new version is available</div>
          <div className="text-sm text-[var(--ink-soft)]">
            Refresh to load the latest updates. Your session will stay signed in.
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={reloading}
              onClick={() => {
                setReloading(true);
                void hardReload();
              }}
              className="rounded-md bg-[var(--wine)] px-3 py-1.5 text-sm font-medium text-[var(--parchment)] hover:bg-[#7a3e45] disabled:opacity-60"
            >
              {reloading ? 'Refreshing…' : 'Refresh now'}
            </button>
            <button
              type="button"
              onClick={() => setUpdateAvailable(false)}
              className="rounded-md border border-[var(--rule)] bg-transparent px-3 py-1.5 text-sm text-[var(--ink-soft)] hover:bg-[var(--parchment-sunk)]"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
