'use client';

// Tag editor for assets. Same UX as TagEditor (notes), but persists
// via PATCH /api/asset-tags using the asset's id instead of a note path.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Tag, X } from 'lucide-react';

export function AssetTagEditor({
  assetId,
  initialTags,
  csrfToken,
  canEdit,
  onTagsChange,
}: {
  assetId: string;
  initialTags: string[];
  csrfToken: string;
  canEdit: boolean;
  onTagsChange?: (tags: string[]) => void;
}): React.JSX.Element {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [adding, setAdding] = useState<boolean>(false);
  const [query, setQuery] = useState<string>('');
  const [knownTags, setKnownTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<number>(0);

  useEffect(() => {
    if (!adding || loaded) return;
    let cancelled = false;
    void fetch('/api/tags')
      .then((r) => r.json())
      .then((body: { tags?: Array<{ tag: string; count: number }> }) => {
        if (cancelled) return;
        setKnownTags(body.tags ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [adding, loaded]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const closeAdd = useCallback(() => {
    setAdding(false);
    setQuery('');
    setHighlight(0);
    setError(null);
  }, []);

  useEffect(() => {
    if (!adding) return;
    const onDoc = (e: MouseEvent): void => {
      if (!popoverRef.current?.contains(e.target as Node)) closeAdd();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [adding, closeAdd]);

  const commit = useCallback(
    async (next: string[]) => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch('/api/asset-tags', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ assetId, tags: next }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          setError(body.error ?? `HTTP ${res.status}`);
          return false;
        }
        const updated: string[] = Array.isArray(body.tags) ? (body.tags as string[]) : next;
        setTags(updated);
        onTagsChange?.(updated);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
        return false;
      } finally {
        setPending(false);
      }
    },
    [assetId, csrfToken, onTagsChange],
  );

  const addTag = useCallback(
    async (raw: string) => {
      const tag = raw.trim().replace(/^#/, '').toLowerCase();
      if (!tag) return;
      if (!/^[a-zA-Z0-9_\-/]+$/.test(tag)) {
        setError('Tags can only use letters, digits, underscores, dashes, and slashes.');
        return;
      }
      if (tags.includes(tag)) { closeAdd(); return; }
      const ok = await commit([...tags, tag]);
      if (ok) closeAdd();
    },
    [tags, commit, closeAdd],
  );

  const removeTag = useCallback(
    async (t: string) => {
      await commit(tags.filter((x) => x !== t));
    },
    [tags, commit],
  );

  const filtered = knownTags
    .map((k) => k.tag)
    .filter((t) => t.includes(query.toLowerCase()) && !tags.includes(t))
    .slice(0, 8);

  const queryNormalised = query.trim().replace(/^#/, '').toLowerCase();
  const showCreate =
    queryNormalised.length > 0 &&
    !filtered.includes(queryNormalised) &&
    !tags.includes(queryNormalised);

  const options: Array<{ label: string; value: string; kind: 'existing' | 'new' }> = [
    ...filtered.map((t) => ({ label: t, value: t, kind: 'existing' as const })),
    ...(showCreate ? [{ label: `Create #${queryNormalised}`, value: queryNormalised, kind: 'new' as const }] : []),
  ];

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') { e.preventDefault(); closeAdd(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(options.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = options[highlight];
      if (pick) void addTag(pick.value);
      else if (queryNormalised) void addTag(queryNormalised);
    }
  };

  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      <Tag size={14} className="text-[#5A4F42]" aria-hidden />

      {tags.map((t) => (
        <Chip key={t} onRemove={canEdit ? () => void removeTag(t) : undefined}>
          #{t}
        </Chip>
      ))}

      {canEdit && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={pending}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-[#D4C7AE] px-2 py-0.5 text-xs text-[#5A4F42] transition hover:border-[#8B4A52]/50 hover:bg-[#8B4A52]/10 hover:text-[#5E3A3F] disabled:opacity-60"
        >
          <Plus size={12} aria-hidden />
          <span>Add tag</span>
        </button>
      )}

      {adding && (
        <div ref={popoverRef} className="relative">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
            onKeyDown={onKeyDown}
            placeholder="Type a tag…"
            className="rounded-full border border-[#D4C7AE] bg-[#FBF5E8] px-2.5 py-0.5 text-xs text-[#2A241E] outline-none placeholder:text-[#5A4F42]/60"
          />
          {options.length > 0 && (
            <ul
              role="listbox"
              className="absolute left-0 top-full z-20 mt-1 max-h-60 w-56 overflow-auto rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_8px_24px_rgba(42,36,30,0.12)]"
            >
              {options.map((opt, i) => (
                <li key={opt.kind + ':' + opt.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => void addTag(opt.value)}
                    className={
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition ' +
                      (i === highlight ? 'bg-[#D4A85A]/20 text-[#2A241E]' : 'text-[#5A4F42] hover:bg-[#D4A85A]/10')
                    }
                  >
                    {opt.kind === 'new' ? <Plus size={12} aria-hidden /> : <Tag size={12} aria-hidden />}
                    <span>{opt.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="w-full text-xs text-[#8B4A52]">{error}</p>}
    </div>
  );
}

function Chip({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-2.5 py-0.5 text-xs font-medium text-[#5E3A3F]">
      <span>{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove tag"
          className="-mr-1 rounded-full p-0.5 text-[#5E3A3F]/60 transition hover:bg-[#8B4A52]/20 hover:text-[#4A2E32]"
        >
          <X size={10} aria-hidden />
        </button>
      )}
    </span>
  );
}
