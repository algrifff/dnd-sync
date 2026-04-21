'use client';

// Number-edit sibling of InlineText. Accepts int or float; empty-string
// commits null.

import { useEffect, useRef, useState } from 'react';

export function InlineNumber({
  value,
  readOnly,
  className,
  inputClassName,
  onCommit,
  min,
  max,
  step,
  allowNull,
  ariaLabel,
  format,
}: {
  value: number | null;
  readOnly?: boolean | undefined;
  className?: string | undefined;
  inputClassName?: string | undefined;
  onCommit: (next: number | null) => void;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  allowNull?: boolean | undefined;
  ariaLabel?: string | undefined;
  format?: ((n: number | null) => string) | undefined;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value == null ? '' : String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const display = format
    ? format(value)
    : value == null
    ? '—'
    : String(value);

  if (readOnly) {
    return <span className={className}>{display}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={ariaLabel ?? 'Edit'}
        className={`text-left hover:outline hover:outline-1 hover:outline-offset-2 hover:outline-[#D4C7AE] rounded ${className ?? ''}`}
      >
        {display}
      </button>
    );
  }

  const commit = (): void => {
    setEditing(false);
    const s = draft.trim();
    if (s === '') {
      if (allowNull && value !== null) onCommit(null);
      return;
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return;
    let clamped = n;
    if (typeof min === 'number') clamped = Math.max(min, clamped);
    if (typeof max === 'number') clamped = Math.min(max, clamped);
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      ref={inputRef}
      type="number"
      inputMode="decimal"
      value={draft}
      step={step ?? 1}
      min={min}
      max={max}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value == null ? '' : String(value));
          setEditing(false);
        }
      }}
      aria-label={ariaLabel ?? 'Edit number'}
      className={`w-16 rounded border border-[#D4C7AE] bg-white px-2 py-1 text-center outline-none focus:border-[#2A241E] ${inputClassName ?? ''}`}
    />
  );
}
