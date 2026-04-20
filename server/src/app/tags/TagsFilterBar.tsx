'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, Tag } from 'lucide-react';

interface TagEntry {
  tag: string;
  count: number;
}

export function TagsFilterBar({ tags }: { tags: TagEntry[] }): React.JSX.Element {
  const [query, setQuery] = useState('');

  const q = query.trim().replace(/^#/, '').toLowerCase();
  const filtered = q ? tags.filter((t) => t.tag.includes(q)) : tags;

  return (
    <div className="space-y-6">
      {/* Search bar */}
      <div className="relative">
        <Search
          size={16}
          className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A4F42]/60 pointer-events-none"
          aria-hidden
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tags…"
          className="w-full rounded-xl border border-[#D4C7AE] bg-[#FBF5E8] py-3 pl-11 pr-4 text-sm text-[#2A241E] outline-none placeholder:text-[#5A4F42]/50 focus:border-[#8B4A52]/60 focus:ring-2 focus:ring-[#8B4A52]/10 transition"
        />
      </div>

      {/* Tag count */}
      <p className="text-sm text-[#5A4F42]">
        {filtered.length === tags.length
          ? `${tags.length} tag${tags.length === 1 ? '' : 's'} across the vault.`
          : `${filtered.length} of ${tags.length} tag${tags.length === 1 ? '' : 's'} matching.`}
      </p>

      {/* Tag chips */}
      {filtered.length === 0 ? (
        <p className="text-sm text-[#5A4F42]">
          {tags.length === 0 ? 'No tags yet. Add one from any note.' : 'No tags match.'}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {filtered.map((t) => (
            <li key={t.tag}>
              <Link
                href={'/tags/' + encodeURIComponent(t.tag)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-1 text-sm font-medium text-[#5E3A3F] transition hover:-translate-y-px hover:bg-[#8B4A52]/20 hover:text-[#4A2E32]"
              >
                <Tag size={12} className="shrink-0" aria-hidden />
                <span>#{t.tag}</span>
                <span className="rounded-full bg-[#8B4A52]/20 px-1.5 text-xs text-[#5E3A3F]/80">
                  {t.count}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
