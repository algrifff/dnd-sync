'use client';

// Global search bar — always sits in the dead-centre column of AppHeader.
// ⌘K on Mac, Ctrl K everywhere else. Detects the OS on first render.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, FileText, Image as ImageIcon, X, User, Users, Skull, Gem, MapPin, ScrollText,
  type LucideIcon,
} from 'lucide-react';
import type { UiSearchResult } from '@/app/api/ui/search/route';
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '@/lib/search-snippet';
import { normalizeKind } from '@/app/notes/sheet-header/util';

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

const KIND_ICONS: Record<string, LucideIcon> = {
  character: User,
  person: Users,
  creature: Skull,
  item: Gem,
  location: MapPin,
  session: ScrollText,
};

function iconFor(r: UiSearchResult): LucideIcon {
  if (r.kind === 'asset') return ImageIcon;
  const kind = normalizeKind(r.noteKind) ?? r.noteKind?.toLowerCase() ?? '';
  return KIND_ICONS[kind] ?? FileText;
}

function Snippet({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.split(SNIPPET_MARK_OPEN).map((part, i) => {
        const [marked, rest] = i === 0 ? ['', part] : part.split(SNIPPET_MARK_CLOSE, 2);
        return (
          <span key={i}>
            {marked && <mark>{marked}</mark>}
            {rest}
          </span>
        );
      })}
    </>
  );
}

export function WorldSearchBar(): React.JSX.Element {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UiSearchResult[]>([]);
  const [resultsFor, setResultsFor] = useState('');
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [isMac, setIsMac] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<AbortController | null>(null);

  // Detect OS once on mount
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? navigator.userAgent));
  }, []);

  // Global keyboard shortcut to focus
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const cancelPending = useCallback((): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    inflightRef.current?.abort();
    inflightRef.current = null;
    setLoading(false);
  }, []);

  useEffect(() => cancelPending, [cancelPending]);

  const search = useCallback(async (q: string): Promise<UiSearchResult[] | null> => {
    inflightRef.current?.abort();
    if (!q.trim()) { setResults([]); setResultsFor(q); setOpen(false); setLoading(false); return []; }
    const controller = new AbortController();
    inflightRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/ui/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
      const data = res.ok ? ((await res.json()) as { results: UiSearchResult[] }) : { results: [] };
      setResults(data.results);
      setResultsFor(q);
      setFailed(!res.ok);
      setOpen(true);
      setActive(0);
      return data.results;
    } catch {
      return null;
    } finally {
      if (inflightRef.current === controller) {
        inflightRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void search(val), 120);
  };

  const navigate = useCallback(
    (result: UiSearchResult): void => {
      cancelPending();
      setOpen(false); setQuery(''); setResults([]);
      inputRef.current?.blur();
      if (result.kind === 'note') router.push('/notes/' + encodePath(result.path));
      else router.push('/assets');
    },
    [router, cancelPending],
  );

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return; }
    if (e.key === 'Enter' && query.trim() && resultsFor !== query) {
      // Typed faster than the debounce: open the top hit for what's in the box now.
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void search(query).then((rs) => { const r = rs?.[0]; if (r) navigate(r); });
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = results[active]; if (r) navigate(r); }
  };

  const clear = (): void => {
    cancelPending();
    setQuery(''); setResults([]); setOpen(false); inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="relative w-72">
      {/* Input pill */}
      <div className="flex items-center gap-1.5 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)]/70 px-2.5 py-1.5 text-sm text-[var(--ink-soft)] transition focus-within:border-[var(--candlelight)] focus-within:bg-[var(--vellum)]">
        <Search size={12} className="shrink-0 text-[var(--ink-muted)]" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          placeholder="Search notes & assets…"
          aria-label="Search world"
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--ink)] placeholder-[var(--ink-muted)] outline-none"
        />
        {loading && (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-[var(--rule)] border-t-[var(--candlelight)]" aria-hidden />
        )}
        {query ? (
          <button type="button" onClick={clear} className="shrink-0 text-[var(--ink-muted)] hover:text-[var(--ink)]" aria-label="Clear">
            <X size={11} aria-hidden />
          </button>
        ) : (
          <kbd className="shrink-0 rounded border border-[var(--rule)] px-1 py-px text-[10px] leading-none text-[var(--ink-muted)]">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        )}
      </div>

      {/* Results dropdown */}
      {open && results.length > 0 && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute left-1/2 top-full z-50 mt-1.5 max-h-[70vh] w-[380px] -translate-x-1/2 overflow-y-auto rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] shadow-lg"
        >
          {results.map((r, i) => {
            const Icon = iconFor(r);
            return (
              <button
                key={r.kind === 'note' ? r.path : r.id}
                role="option"
                aria-selected={i === active}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => navigate(r)}
                className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition ${i === active ? 'bg-[var(--parchment)]' : 'hover:bg-[var(--parchment)]'} ${i > 0 ? 'border-t border-[var(--rule)]/50' : ''}`}
              >
                <span className="mt-0.5 shrink-0 text-[var(--ink-muted)]">
                  <Icon size={13} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-[var(--ink)]">
                    {r.kind === 'note' ? r.title : r.name}
                  </span>
                  {r.kind === 'note' && r.snippet && (
                    <span className="block truncate text-[11px] text-[var(--ink-soft)]">
                      <Snippet text={r.snippet} />
                    </span>
                  )}
                  {r.kind === 'note' && (
                    <span className="block truncate text-[10px] text-[var(--ink-muted)]">{r.path}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {open && query.trim() && results.length === 0 && !loading && (
        <div className="absolute left-1/2 top-full z-50 mt-1.5 w-[300px] -translate-x-1/2 rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] px-3 py-3 shadow-lg">
          <p className="text-xs text-[var(--ink-muted)]">
            {failed ? 'Search failed. Try again.' : <>No results for &ldquo;{query}&rdquo;</>}
          </p>
        </div>
      )}
    </div>
  );
}
