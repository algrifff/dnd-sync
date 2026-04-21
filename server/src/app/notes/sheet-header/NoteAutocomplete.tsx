'use client';

// Typeahead picker for linking a header field to another note (a
// person's home location, a location's parent, etc). Queries
// /api/notes/suggest?kind=... with 200ms debounce. Keyboard nav:
// ArrowUp/Down to select, Enter to commit, Escape to cancel, Tab or
// blur to accept highlighted.

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  NoteSuggestHit,
  NoteSuggestResponse,
} from '@/app/api/notes/suggest/route';

export function NoteAutocomplete({
  value,
  readOnly,
  kind,
  placeholder,
  ariaLabel,
  className,
  onCommit,
}: {
  value: string | null | undefined;
  readOnly?: boolean | undefined;
  kind: 'location' | 'character' | 'creature' | 'item';
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  className?: string | undefined;
  /** next = note path (existing note), or null to clear. */
  onCommit: (next: string | null) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [hits, setHits] = useState<NoteSuggestHit[]>([]);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync draft with value when we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Debounced fetch.
  useEffect(() => {
    if (!editing) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/notes/suggest?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(draft)}`,
            { credentials: 'same-origin' },
          );
          if (!res.ok) {
            setHits([]);
            return;
          }
          const body = (await res.json()) as NoteSuggestResponse;
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
  }, [draft, kind, editing]);

  const display = value ?? '';

  if (readOnly) {
    return (
      <span className={className}>
        {display || (
          <span className="text-[#8A7E6B]">{placeholder ?? '—'}</span>
        )}
      </span>
    );
  }

  if (!editing) {
    return (
      <div className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label={ariaLabel ?? 'Edit link'}
          className={`rounded text-left hover:outline hover:outline-1 hover:outline-offset-2 hover:outline-[#D4C7AE] ${className ?? ''}`}
        >
          {display || (
            <span className="text-[#8A7E6B]">
              {placeholder ?? 'Click to link…'}
            </span>
          )}
        </button>
        {display && (
          <button
            type="button"
            onClick={() => onCommit(null)}
            aria-label="Remove link"
            className="text-[#8A7E6B] hover:text-[#8B4A52]"
          >
            <X size={11} />
          </button>
        )}
      </div>
    );
  }

  const commit = (path: string | null): void => {
    setEditing(false);
    setHits([]);
    if (path !== (value ?? null)) onCommit(path);
  };
  const cancel = (): void => {
    setDraft(value ?? '');
    setEditing(false);
    setHits([]);
  };

  return (
    <div className="relative inline-block">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          // Give click-on-row a tick to fire before we collapse.
          setTimeout(() => {
            if (!editing) return;
            if (hits[highlight]) commit(hits[highlight]!.path);
            else commit(draft.trim() === '' ? null : draft.trim());
          }, 120);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (hits[highlight]) commit(hits[highlight]!.path);
            else commit(draft.trim() === '' ? null : draft.trim());
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(hits.length - 1, h + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(0, h - 1));
          }
        }}
        placeholder={placeholder ?? 'search or paste a path…'}
        aria-label={ariaLabel ?? 'Link to note'}
        className="w-56 rounded border border-[#D4C7AE] bg-white px-2 py-1 text-[11px] outline-none focus:border-[#2A241E]"
      />
      {hits.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1 max-h-60 w-64 overflow-auto rounded-[8px] border border-[#D4C7AE] bg-white shadow-lg"
        >
          {hits.map((h, i) => (
            <li key={h.path}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  // mousedown fires before blur — commit immediately.
                  e.preventDefault();
                  commit(h.path);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`block w-full px-2 py-1 text-left text-[11px] ${
                  i === highlight
                    ? 'bg-[#EAE1CF] text-[#2A241E]'
                    : 'text-[#2A241E] hover:bg-[#F4EDE0]'
                }`}
              >
                <div className="truncate">{h.name}</div>
                <div className="truncate font-mono text-[10px] text-[#8A7E6B]">
                  {h.path}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
