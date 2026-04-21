'use client';

// Pill-shaped select. Renders like Pill but becomes a native <select>
// on focus. Used for category/rarity/disposition/type/size.

import { useEffect, useRef, useState } from 'react';

export type ChipOption = { value: string; label: string };

export function ChipSelect({
  value,
  options,
  readOnly,
  onCommit,
  tone,
  placeholder,
  ariaLabel,
}: {
  value: string | null | undefined;
  options: ReadonlyArray<ChipOption>;
  readOnly?: boolean | undefined;
  onCommit: (next: string) => void;
  /** CSS var name (without `--`) for chip colour. */
  tone?: string | undefined;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    if (editing && ref.current) ref.current.focus();
  }, [editing]);

  const label =
    options.find((o) => o.value === value)?.label ?? placeholder ?? '—';
  const color = tone ? `var(--${tone})` : undefined;

  if (readOnly || !editing) {
    const chip = (
      <span
        className="inline-flex items-center rounded-full border bg-[#F4EDE0] px-2 py-0.5 text-[11px] font-medium"
        style={{
          borderColor: color ?? '#D4C7AE',
          color: color ?? '#2A241E',
        }}
      >
        {label}
      </span>
    );
    if (readOnly) return chip;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={ariaLabel ?? 'Change'}
        className="rounded-full hover:outline hover:outline-1 hover:outline-offset-1 hover:outline-[#D4C7AE]"
      >
        {chip}
      </button>
    );
  }

  return (
    <select
      ref={ref}
      value={value ?? ''}
      onChange={(e) => {
        const next = e.target.value;
        setEditing(false);
        if (next && next !== value) onCommit(next);
      }}
      onBlur={() => setEditing(false)}
      aria-label={ariaLabel ?? 'Select'}
      className="rounded-full border border-[#D4C7AE] bg-white px-2 py-0.5 text-[11px] outline-none focus:border-[#2A241E]"
    >
      {!value && <option value="" disabled>{placeholder ?? 'Choose…'}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
