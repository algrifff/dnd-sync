'use client';

// Single ability: 3-letter label, score, computed modifier. Editable
// inline for creatures; read-only on the character header (ability
// scores edited in the side sheet panel).

import { abilityModifier, formatModifier } from './util';
import { InlineNumber } from './InlineNumber';

export function AbilityScoreBox({
  label,
  score,
  readOnly,
  onCommit,
}: {
  label: string;
  score: number;
  readOnly?: boolean | undefined;
  onCommit?: ((next: number) => void) | undefined;
}): React.JSX.Element {
  const mod = abilityModifier(score);
  return (
    <div className="flex w-[66px] flex-col items-center rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] px-1.5 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#5A4F42]">
        {label}
      </span>
      {readOnly || !onCommit ? (
        <span className="font-serif text-lg text-[#2A241E]">{score}</span>
      ) : (
        <InlineNumber
          value={score}
          onCommit={(n) => onCommit(n ?? 10)}
          min={1}
          max={30}
          inputClassName="font-serif text-lg w-12"
          ariaLabel={label}
        />
      )}
      <span className="text-xs text-[#5A4F42]">{formatModifier(mod)}</span>
    </div>
  );
}
