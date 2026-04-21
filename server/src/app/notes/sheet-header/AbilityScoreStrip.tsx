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
    <div className="flex flex-wrap gap-1.5">
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
