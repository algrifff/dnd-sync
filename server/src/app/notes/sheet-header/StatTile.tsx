'use client';

// Small labelled value tile (AC / HP / Speed). Read-only by default;
// supply `onCommit` for inline-number editing.

import type { ReactNode } from 'react';
import { InlineNumber } from './InlineNumber';

export function StatTile({
  label,
  value,
  suffix,
  readOnly,
  onCommit,
  children,
}: {
  label: string;
  value?: number | null | undefined;
  suffix?: string | undefined;
  readOnly?: boolean | undefined;
  onCommit?: ((next: number | null) => void) | undefined;
  /** For composite values (e.g. HP "18 / 38") — renders instead of `value`. */
  children?: ReactNode | undefined;
}): React.JSX.Element {
  return (
    <div className="flex min-w-[64px] flex-col items-center rounded-[10px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
        {label}
      </span>
      <span className="flex items-center gap-1 font-serif text-lg font-semibold text-[var(--ink)]">
        {children ? (
          children
        ) : onCommit && !readOnly ? (
          <InlineNumber
            value={value ?? null}
            onCommit={onCommit}
            className="font-serif text-lg font-semibold text-[var(--ink)]"
            inputClassName="font-serif text-lg font-semibold w-12 text-[var(--ink)]"
            ariaLabel={label}
          />
        ) : (
          <span>{value == null ? '—' : String(value)}</span>
        )}
        {suffix ? <span className="text-xs text-[var(--ink-soft)]">{suffix}</span> : null}
      </span>
    </div>
  );
}
