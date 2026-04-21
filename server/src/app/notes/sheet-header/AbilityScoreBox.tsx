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
    // aspect-square keeps the ~1:1 ratio as the grid cell widens;
    // padding and fonts scale up so the label / score / modifier
    // stay centred and readable at the larger size.
    <div className="flex aspect-square w-full flex-col items-center justify-center rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[#5A4F42]">
        {label}
      </span>
      {readOnly || !onCommit ? (
        <span className="font-serif text-3xl font-semibold leading-tight text-[#2A241E]">
          {score}
        </span>
      ) : (
        <InlineNumber
          value={score}
          onCommit={(n) => onCommit(n ?? 10)}
          min={1}
          max={30}
          // Same classes on both display button and edit input so the
          // font / size / weight stay identical whether you're editing
          // or just looking at the number.
          className="font-serif text-3xl font-semibold leading-tight text-[#2A241E]"
          inputClassName="font-serif text-3xl font-semibold leading-tight w-16 text-[#2A241E]"
          ariaLabel={label}
        />
      )}
      <span className="text-sm font-medium text-[#5A4F42]">
        {formatModifier(mod)}
      </span>
    </div>
  );
}
