'use client';

// Bordered parchment chip — read-only. For selectable variants use
// ChipSelect; for tag lists use TagChips.

import type { ReactNode } from 'react';

export function Pill({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  /** CSS variable name without the leading `--`, e.g. "moss". */
  tone?: string;
  title?: string;
}): React.JSX.Element {
  const color = tone ? `var(--${tone})` : undefined;
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-full border bg-[#F4EDE0] px-2 py-0.5 text-[11px] font-medium"
      style={{
        borderColor: color ?? '#D4C7AE',
        color: color ?? '#2A241E',
      }}
    >
      {children}
    </span>
  );
}
