'use client';

// Add/remove chips for a string[] field. Press Enter or comma to add,
// Backspace on empty input removes the last chip.

import { useState } from 'react';
import { X } from 'lucide-react';

export function TagChips({
  tags,
  readOnly,
  onChange,
  placeholder = 'add tag…',
}: {
  tags: string[];
  readOnly?: boolean | undefined;
  onChange?: ((next: string[]) => void) | undefined;
  placeholder?: string | undefined;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');

  const add = (raw: string): void => {
    const v = raw.trim();
    if (!v) return;
    if (tags.includes(v)) return;
    onChange?.([...tags, v]);
    setDraft('');
  };

  const remove = (t: string): void => {
    onChange?.(tags.filter((x) => x !== t));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-full border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-0.5 text-[11px] text-[#2A241E]"
        >
          {t}
          {!readOnly && (
            <button
              type="button"
              onClick={() => remove(t)}
              aria-label={`Remove ${t}`}
              className="text-[#5A4F42] hover:text-[#8B4A52]"
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && draft === '' && tags.length) {
              e.preventDefault();
              remove(tags[tags.length - 1]!);
            }
          }}
          onBlur={() => add(draft)}
          placeholder={placeholder}
          className="min-w-[80px] rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] outline-none focus:border-[#D4C7AE] focus:bg-white"
        />
      )}
    </div>
  );
}
