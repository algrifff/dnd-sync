'use client';

// Global search bar in the top header. Cmd/Ctrl+K focuses it.
// Results appear in a floating dropdown below; clicking navigates.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, FileText, Image as ImageIcon, X } from 'lucide-react';
import type { UiSearchResult } from '@/app/api/ui/search/route';

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export function WorldSearchBar(): React.JSX.Element {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UiSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cmd/Ctrl+K focuses the bar
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

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const search = useCallback(async (q: string): Promise<void> => {
    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/ui/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { results: UiSearchResult[] };
      setResults(data.results);
      setOpen(true);
      setActive(-1);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void search(val), 200);
  };

  const navigate = useCallback(
    (result: UiSearchResult): void => {
      setOpen(false);
      setQuery('');
      setResults([]);
      if (result.kind === 'note') {
        router.push('/notes/' + encodePath(result.path));
      } else {
        router.push('/assets');
      }
    },
    [router],
  );

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      const r = results[active];
      if (r) navigate(r);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const clear = (): void => {
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="relative flex-1 max-w-sm">
      <div className="flex items-center gap-1.5 rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-2.5 py-1 text-sm text-[#5A4F42] focus-within:border-[#D4A85A] focus-within:bg-[#FBF5E8] transition">
        <Search size={13} className="shrink-0 text-[#8A7E6E]" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          placeholder="Search notes & assets…"
          aria-label="Search world"
          className="flex-1 min-w-0 bg-transparent text-xs text-[#2A241E] placeholder-[#8A7E6E] outline-none"
        />
        {loading && (
          <span className="h-3 w-3 animate-spin rounded-full border border-[#D4C7AE] border-t-[#D4A85A]" aria-hidden />
        )}
        {query && !loading && (
          <button
            type="button"
            onClick={clear}
            className="shrink-0 text-[#8A7E6E] hover:text-[#2A241E]"
            aria-label="Clear search"
          >
            <X size={12} aria-hidden />
          </button>
        )}
        <kbd className="shrink-0 rounded border border-[#D4C7AE] px-1 text-[10px] text-[#8A7E6E] hidden sm:inline">⌘K</kbd>
      </div>

      {open && results.length > 0 && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 top-full z-50 mt-1 w-full min-w-[320px] overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-lg"
        >
          {results.map((r, i) => (
            <button
              key={r.kind === 'note' ? r.path : r.id}
              role="option"
              aria-selected={i === active}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => navigate(r)}
              className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition ${
                i === active ? 'bg-[#F4EDE0]' : 'hover:bg-[#F4EDE0]'
              } ${i > 0 ? 'border-t border-[#D4C7AE]/50' : ''}`}
            >
              <span className="mt-0.5 shrink-0 text-[#8A7E6E]">
                {r.kind === 'note' ? <FileText size={13} aria-hidden /> : <ImageIcon size={13} aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-[#2A241E]">
                  {r.kind === 'note' ? r.title : r.filename}
                </span>
                {r.kind === 'note' && r.snippet && (
                  <span
                    className="block truncate text-[11px] text-[#5A4F42]"
                    dangerouslySetInnerHTML={{ __html: r.snippet }}
                  />
                )}
                {r.kind === 'note' && (
                  <span className="block truncate text-[10px] text-[#8A7E6E]">{r.path}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {open && query.trim() && results.length === 0 && !loading && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full min-w-[280px] rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] px-3 py-3 shadow-lg">
          <p className="text-xs text-[#8A7E6E]">No results for &ldquo;{query}&rdquo;</p>
        </div>
      )}
    </div>
  );
}
