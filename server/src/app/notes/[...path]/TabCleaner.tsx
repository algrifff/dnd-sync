'use client';

// Runs inside the note-not-found page. Removes the current (dead)
// note path from the NoteTabs localStorage list so the tab stops
// lingering, then routes home. If the user closes the tab manually
// before the timeout fires they still get the benefit of the
// cleanup because that happens synchronously on mount.

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const TABS_STORAGE_KEY = 'compendium.tabs.v1';

type StoredTab = { path: string; title: string };

export function TabCleaner(): null {
  const router = useRouter();
  const pathname = usePathname() ?? '';

  useEffect(() => {
    if (!pathname.startsWith('/notes/')) return;
    const notePath = decode(pathname.slice('/notes/'.length));

    try {
      const raw = localStorage.getItem(TABS_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        const next = parsed.filter(
          (t): t is StoredTab =>
            !!t &&
            typeof t === 'object' &&
            typeof (t as StoredTab).path === 'string' &&
            (t as StoredTab).path !== notePath,
        );
        localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(next));
      }
    } catch {
      /* quota / private-mode / malformed — leave it */
    }

    const t = setTimeout(() => router.push('/'), 1500);
    return () => clearTimeout(t);
  }, [pathname, router]);

  return null;
}

function decode(rest: string): string {
  return rest
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}
