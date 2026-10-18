'use client';

// Runs inside the note-not-found page. Removes the current (dead)
// note path from the NoteTabs localStorage list so the tab stops
// lingering, then routes home. If the user closes the tab manually
// before the timeout fires they still get the benefit of the
// cleanup because that happens synchronously on mount.

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { readTabs, writeTabs } from '../../../../note-tabs-storage';

export function TabCleaner({ groupId }: { groupId: string }): null {
  const router = useRouter();
  const pathname = usePathname() ?? '';

  useEffect(() => {
    if (!pathname.startsWith('/notes/')) return;
    const notePath = decode(pathname.slice('/notes/'.length));

    const tabs = readTabs(groupId);
    const next = tabs.filter((t) => t.path !== notePath);
    if (next.length !== tabs.length) writeTabs(groupId, next);

    // replace, not push — this URL is dead, Back shouldn't return to it.
    const t = setTimeout(() => router.replace('/home'), 1500);
    return () => clearTimeout(t);
  }, [pathname, router, groupId]);

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
