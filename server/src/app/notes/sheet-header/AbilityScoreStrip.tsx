'use client';

import { AbilityScoreBox } from './AbilityScoreBox';

const KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type AbilityKey = (typeof KEYS)[number];

export function AbilityScoreStrip({
  scores,
  readOnly,
  onChange,
}: {
  scores: Record<AbilityKey, number>;
  readOnly?: boolean | undefined;
  onChange?: ((next: Record<AbilityKey, number>) => void) | undefined;
}): React.JSX.Element {
  return (
    // 6-column grid so the boxes fill the full header width and stay
    // evenly spaced at any column width; `aspect-square` on each box
    // preserves the ~1:1 ratio as the row grows.
    <div className="grid grid-cols-6 gap-3">
      {KEYS.map((k) => (
        <AbilityScoreBox
          key={k}
          label={k.toUpperCase()}
          score={scores[k]}
          readOnly={readOnly}
          onCommit={
            onChange
              ? (n) => onChange({ ...scores, [k]: n })
              : undefined
          }
        />
      ))}
    </div>
  );
}
