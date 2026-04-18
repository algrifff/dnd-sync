'use client';

// Persistent tab strip of open notes. Stored in localStorage so tabs
// survive reloads; the tab matching the current URL is "active". Opening
// a note (any /notes/<path>) adds it to the list; X removes. Removing the
// active tab routes to the next tab, or `/` if empty.
//
// Non-note routes (home, /tags, /admin/...) just render the tab strip as
// a passive preview — the "active" dot moves off, but the tabs stay.

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { X, FileText } from 'lucide-react';

const STORAGE_KEY = 'compendium.tabs.v1';

type Tab = { path: string; title: string };

export function NoteTabs(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const activePath = decodeNotePath(pathname);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        const clean = parsed.filter(
          (t): t is Tab =>
            !!t &&
            typeof t === 'object' &&
            typeof (t as Tab).path === 'string' &&
            typeof (t as Tab).title === 'string',
        );
        setTabs(clean);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Add / refresh the current note in the tab list.
  useEffect(() => {
    if (!activePath) return;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === activePath);
      const title = prettyTitle(activePath);
      if (idx >= 0) {
        if (prev[idx]!.title === title) return prev;
        const next = prev.slice();
        next[idx] = { path: activePath, title };
        return next;
      }
      return [...prev, { path: activePath, title }];
    });
  }, [activePath]);

  // Persist.
  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      /* ignore */
    }
  }, [tabs, mounted]);

  const close = useCallback(
    (path: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== path);
        if (path === activePath) {
          // If we're closing the active tab, route to the next open tab.
          const idx = prev.findIndex((t) => t.path === path);
          const neighbour = next[idx] ?? next[idx - 1] ?? null;
          if (neighbour) router.push(noteHref(neighbour.path));
          else router.push('/');
        }
        return next;
      });
    },
    [activePath, router],
  );

  if (!mounted || tabs.length === 0) {
    return <div className="flex min-w-0 flex-1 items-center" aria-hidden />;
  }

  return (
    <div
      role="tablist"
      aria-label="Open notes"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {tabs.map((t) => {
        const isActive = t.path === activePath;
        return (
          <a
            key={t.path}
            role="tab"
            aria-selected={isActive}
            href={noteHref(t.path)}
            onClick={(e) => {
              e.preventDefault();
              router.push(noteHref(t.path));
            }}
            className={
              'group flex max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 rounded-t-[8px] border-b-2 px-3 py-1.5 text-xs transition ' +
              (isActive
                ? 'border-[#8B4A52] bg-[#FBF5E8] text-[#2A241E]'
                : 'border-transparent text-[#5A4F42] hover:bg-[#FBF5E8]/60 hover:text-[#2A241E]')
            }
          >
            <FileText size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{t.title}</span>
            <button
              type="button"
              onClick={(e) => close(t.path, e)}
              aria-label={`Close ${t.title}`}
              className="-mr-1 rounded-full p-0.5 text-[#5A4F42]/60 opacity-0 transition hover:bg-[#2A241E]/10 hover:text-[#2A241E] group-hover:opacity-100 aria-[selected=true]:opacity-100"
            >
              <X size={10} aria-hidden />
            </button>
          </a>
        );
      })}
    </div>
  );
}

function noteHref(path: string): string {
  return '/notes/' + path.split('/').map(encodeURIComponent).join('/');
}

function decodeNotePath(pathname: string): string {
  if (!pathname.startsWith('/notes/')) return '';
  const rest = pathname.slice('/notes/'.length);
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

function prettyTitle(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(md|canvas)$/i, '');
}
