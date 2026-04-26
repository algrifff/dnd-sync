'use client';

// Filterable note picker popover. Used by:
//   * Sidebar "add backlink" (+) button — anchors to the button
//   * Slash menu "Link to note" command — anchors to the caret
//
// Loads the note index from /api/tree on mount; users filter by
// fuzzy-matching against path + title, keyboard-nav with arrows,
// commit with Enter. Click-outside / Escape dismisses.
//
// `onSelect` receives the vault-relative path (e.g. "Folder/Note.md")
// so callers can either insert a wikilink or record an association.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Entry = { path: string; title: string };

export function NotePicker({
  anchor,
  onSelect,
  onClose,
  excludePath,
  autoFocus = true,
}: {
  /** Viewport-coord top-left for the popover. */
  anchor: { left: number; top: number };
  onSelect: (path: string) => void;
  onClose: () => void;
  /** Omit a path from the list — typically the currently-open note. */
  excludePath?: string;
  autoFocus?: boolean;
}): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState<string>('');
  const [highlight, setHighlight] = useState<number>(0);
  const [loaded, setLoaded] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [autoFocus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/tree', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { root?: unknown };
        const collected: Entry[] = [];
        walk(body.root, collected);
        if (!cancelled) {
          setEntries(collected);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (!popoverRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = excludePath ? entries.filter((e) => e.path !== excludePath) : entries;
    if (!q) return pool.slice(0, 50);
    return pool
      .map((e) => ({ e, score: scoreMatch(e, q) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((s) => s.e);
  }, [entries, query, excludePath]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const commit = useCallback(
    (path: string) => {
      onSelect(path);
    },
    [onSelect],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (filtered.length === 0 ? 0 : (h + 1) % filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) =>
        filtered.length === 0 ? 0 : (h - 1 + filtered.length) % filtered.length,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[highlight];
      if (pick) commit(pick.path);
    }
  };

  // Clamp the preferred anchor to the viewport so the popover is
  // always fully on screen regardless of where the caller put it.
  // Using a conservative max-size estimate (w-80 → 320px, ~400px tall
  // at full list) so the calc is synchronous and the popover doesn't
  // flash in the wrong spot on first render.
  const POPOVER_W = 320;
  const POPOVER_H_EST = 360;
  const vw = typeof window !== 'undefined' ? window.innerWidth : POPOVER_W;
  const vh = typeof window !== 'undefined' ? window.innerHeight : POPOVER_H_EST;
  const left = Math.max(8, Math.min(anchor.left, vw - POPOVER_W - 8));
  const top = Math.max(8, Math.min(anchor.top, vh - POPOVER_H_EST - 8));

  // Portal to document.body so any ancestor `transform` / `filter` /
  // `contain` can't capture our `position: fixed` and break clamping.
  if (typeof document === 'undefined') return <></>;
  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-50 w-80 overflow-hidden rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_12px_32px_rgb(var(--ink-rgb) / 0.18)]"
      style={{ left, top }}
    >
      <div className="border-b border-[var(--rule)] p-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Link to note…"
          className="w-full rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]/60 focus:border-[var(--candlelight)]"
        />
      </div>
      {!loaded ? (
        <div className="px-3 py-2 text-xs text-[var(--ink-soft)]">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[var(--ink-soft)]">
          {query ? 'No matches' : 'No notes yet'}
        </div>
      ) : (
        <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
          {filtered.map((entry, i) => (
            <li key={entry.path}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(entry.path);
                }}
                className={
                  'flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm transition ' +
                  (i === highlight
                    ? 'bg-[var(--candlelight)]/20 text-[var(--ink)]'
                    : 'text-[var(--ink)] hover:bg-[var(--candlelight)]/10')
                }
              >
                <span className="truncate font-medium">
                  {entry.title || entry.path}
                </span>
                <span className="truncate text-xs text-[var(--ink-soft)]">{entry.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

// Flatten the tree JSON from /api/tree into a list of entries.
function walk(node: unknown, out: Entry[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as {
    kind?: unknown;
    path?: unknown;
    title?: unknown;
    name?: unknown;
    children?: unknown;
  };
  if (n.kind === 'file' && typeof n.path === 'string') {
    const titleRaw = typeof n.title === 'string' && n.title ? n.title : '';
    const nameRaw = typeof n.name === 'string' ? n.name : '';
    const title = titleRaw || nameRaw.replace(/\.(md|canvas)$/i, '');
    out.push({ path: n.path, title });
    return;
  }
  if (Array.isArray(n.children)) for (const c of n.children) walk(c, out);
}

// Fuzzy-match score: higher = better. Prefix matches on the title
// win; substring matches on path still count.
function scoreMatch(entry: Entry, q: string): number {
  const title = entry.title.toLowerCase();
  const path = entry.path.toLowerCase();
  if (title === q) return 1000;
  if (title.startsWith(q)) return 500;
  if (title.includes(q)) return 200;
  if (path.includes(q)) return 50;
  // Token match: all query chars appear in order (subsequence).
  let qi = 0;
  for (let i = 0; qi < q.length && i < title.length; i++) {
    if (title[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 10;
  return 0;
}
