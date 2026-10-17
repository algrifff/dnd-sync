'use client';

import { FileText, Link2, Link2Off, Sparkles, type LucideIcon } from 'lucide-react';
import { doneChips, type DoneChip, type WrapUpOutcome } from './wrap-up-review';

const CHIP: Record<DoneChip['key'], { Icon: LucideIcon; noun: (n: number) => string; tone: string }> = {
  updated: { Icon: FileText, noun: (n) => (n === 1 ? 'note' : 'notes'), tone: 'text-[var(--ink)]' },
  created: { Icon: Sparkles, noun: () => 'new', tone: 'text-[var(--wine)]' },
  recorded: { Icon: Link2, noun: (n) => (n === 1 ? 'relationship' : 'relationships'), tone: 'text-[var(--ink)]' },
  skipped: { Icon: Link2Off, noun: () => 'skipped', tone: 'text-[var(--ink-muted)]' },
};

/** What a Wrap-up changed, as figures. Zero counts are left out. */
export function WrapUpDoneChips({ outcome }: { outcome: WrapUpOutcome | null }): React.JSX.Element | null {
  const chips = doneChips(outcome);
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-hidden>
      {chips.map((chip, i) => {
        const { Icon, noun, tone } = CHIP[chip.key];
        return (
          <li
            key={chip.key}
            className={`wu-chip wu-enter text-xs ${tone}`}
            style={{ '--i': i + 3 } as React.CSSProperties}
          >
            <Icon size={12} strokeWidth={2.25} />
            <span className="tabular-nums">{chip.count}</span>
            {noun(chip.count)}
          </li>
        );
      })}
    </ul>
  );
}
