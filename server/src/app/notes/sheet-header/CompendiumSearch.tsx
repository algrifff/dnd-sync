'use client';

// Typeahead over the compendium for attaching a canonical entry
// (Longsword, Potion of Healing, etc.) to a world note. On pick, we
// hand the full entry back to the caller so they can autofill the
// sheet in a single PATCH. 200ms debounce, keyboard nav matches
// NoteAutocomplete.

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type {
  CompendiumSearchHit,
  CompendiumSearchResponse,
} from '@/app/api/compendium/search/route';

export function CompendiumSearch({
  kind,
  placeholder,
  ariaLabel,
  onPick,
}: {
  kind: 'item' | 'monster' | 'spell' | 'class' | 'race' | 'background' | 'feat';
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  onPick: (hit: CompendiumSearchHit) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CompendiumSearchHit[]>([]);
  const [highlight, setHighlight] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/compendium/search?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q)}`,
            { credentials: 'same-origin' },
          );
          if (!res.ok) {
            setHits([]);
            return;
          }
          const body = (await res.json()) as CompendiumSearchResponse;
          setHits(body.results);
          setHighlight(0);
        } catch {
          setHits([]);
        }
      })();
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, kind, open]);

  const pick = (h: CompendiumSearchHit): void => {
    onPick(h);
    setOpen(false);
    setQ('');
    setHits([]);
  };

  return (
    <div className="relative inline-block">
      <div className="inline-flex items-center gap-1 rounded border border-[var(--rule)] bg-white px-2 py-1 text-[11px] focus-within:border-[var(--ink)]">
        <Search size={12} className="text-[var(--ink-muted)]" />
        <input
          type="text"
          value={q}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // let click-on-row fire first
            setTimeout(() => setOpen(false), 120);
          }}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (hits[highlight]) pick(hits[highlight]!);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((h) => Math.min(hits.length - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            }
          }}
          placeholder={placeholder ?? 'Search compendium…'}
          aria-label={ariaLabel ?? 'Search compendium'}
          className="w-48 bg-transparent outline-none"
        />
      </div>
      {open && hits.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1 max-h-60 w-72 overflow-auto rounded-[8px] border border-[var(--rule)] bg-white shadow-lg"
        >
          {hits.map((h, i) => (
            <li key={h.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(h);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`block w-full px-2 py-1 text-left text-[11px] ${
                  i === highlight
                    ? 'bg-[var(--parchment-sunk)] text-[var(--ink)]'
                    : 'text-[var(--ink)] hover:bg-[var(--parchment)]'
                }`}
              >
                <div className="truncate">{h.name}</div>
                <div className="truncate font-mono text-[10px] text-[var(--ink-muted)]">
                  {h.kind}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && q.trim() !== '' && hits.length === 0 && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-[8px] border border-[var(--rule)] bg-white px-2 py-1.5 text-[11px] text-[var(--ink-muted)] shadow-lg">
          No matches. The compendium may not be seeded yet.
        </div>
      )}
    </div>
  );
}
