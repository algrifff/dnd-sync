'use client';

// Persistent tab strip of open notes. Stored in localStorage so tabs
// survive reloads; the tab matching the current URL is "active". Opening
// a note (any /notes/<path>) adds it to the list; X removes. Removing the
// active tab routes to the next tab, or `/` if empty.
//
// Non-note routes (home, /tags, /admin/...) just render the tab strip as
// a passive preview — the "active" dot moves off, but the tabs stay.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { X, FileText } from 'lucide-react';
import { TREE_CHANGE_EVENT, TREE_CHANGE_REMOTE_EVENT } from '@/lib/tree-sync';

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

  // Prune tabs whose notes no longer exist. Runs on mount (catches
  // stale tabs carried across sessions) and whenever a tree-change
  // event fires locally — covers the "someone else deleted this note
  // while the tab is in my background list" case that would otherwise
  // only self-heal when the user clicks the tab.
  const activePathRef = useRef<string>(activePath);
  activePathRef.current = activePath;
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    const validate = async (): Promise<void> => {
      try {
        const res = await fetch('/api/tree', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { root?: unknown };
        const existing = new Set<string>();
        walkTree(body.root, existing);
        setTabs((prev) => {
          const next = prev.filter((t) => existing.has(t.path));
          if (next.length === prev.length) return prev;
          const current = activePathRef.current;
          if (current && !existing.has(current)) {
            // The active tab's note no longer exists — route to a
            // surviving neighbour, falling back to home.
            const neighbour = next[0] ?? null;
            if (neighbour) router.push(noteHref(neighbour.path));
            else router.push('/');
          }
          return next;
        });
      } catch {
        /* ignore — stale tabs will self-heal on next event */
      }
    };
    void validate();
    const onTreeChange = (): void => void validate();
    document.addEventListener(TREE_CHANGE_EVENT, onTreeChange);
    document.addEventListener(TREE_CHANGE_REMOTE_EVENT, onTreeChange);
    return () => {
      cancelled = true;
      document.removeEventListener(TREE_CHANGE_EVENT, onTreeChange);
      document.removeEventListener(TREE_CHANGE_REMOTE_EVENT, onTreeChange);
    };
  }, [mounted, router]);

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
    return <div className="flex min-w-0 flex-1 items-end" aria-hidden />;
  }

  return (
    <div
      role="tablist"
      aria-label="Open notes"
      className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"
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
              'group relative flex max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 rounded-t-[8px] px-3 py-1.5 text-xs transition ' +
              (isActive
                ? // Active tab matches content bg; a pseudo-element
                  // extends that bg 2 px below the tab to conclusively
                  // cover the header's border-b line regardless of
                  // subpixel rendering, so the tab appears to flow
                  // straight into the content pane.
                  'z-10 border border-b-0 border-[#D4C7AE] bg-[#F4EDE0] text-[#2A241E] ' +
                  'after:content-[""] after:absolute after:inset-x-0 after:top-full after:h-[2px] after:bg-[#F4EDE0]'
                : 'border border-transparent text-[#5A4F42] hover:bg-[#FBF5E8]/70 hover:text-[#2A241E]')
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

// Recurse the tree JSON dump from /api/tree, collecting every file
// path. The server module defines this shape; we only care about
// `path` and whether it's a file vs dir.
function walkTree(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as {
    kind?: unknown;
    path?: unknown;
    children?: unknown;
  };
  if (n.kind === 'file' && typeof n.path === 'string') {
    out.add(n.path);
    return;
  }
  if (Array.isArray(n.children)) for (const c of n.children) walkTree(c, out);
}
