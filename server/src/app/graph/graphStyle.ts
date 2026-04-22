// Visual styling for the mind-map. Tag-driven colour with a
// deterministic priority order so a note carrying multiple
// "category" tags renders consistently regardless of which one
// happens to be first in its list.
//
// Priority (highest first):
//   villain   → wine        (antagonists, the red team)
//   location  → moss        (places)
//   ally      → sage        (friendly NPCs)
//   official  → sage        (shares sage with ally — both "trustworthy people")
//   session   → embers      (adventure log entries)
//   else      → ink-soft    (everything uncategorised)
//
// Anything not in the table falls through to the ink-soft default.
// New categories: add a row here, ordered by the priority you want.

export const NODE_BASE_RADIUS = 4;
export const NODE_DEGREE_COEFF = 2.2;

export type TagStyle = {
  tag: string;
  color: string;
};

const PRIORITY: TagStyle[] = [
  { tag: 'villain', color: '#8B4A52' },
  { tag: 'location', color: '#7B8A5F' },
  { tag: 'ally', color: '#6B7F8E' },
  { tag: 'official', color: '#6B7F8E' },
  { tag: 'session', color: '#B5572A' },
];

const DEFAULT_COLOR = '#5A4F42';

/** Pick the colour for a node given its tag list. */
export function colorForTags(tags: readonly string[]): string {
  if (!tags.length) return DEFAULT_COLOR;
  const lc = new Set(tags.map((t) => t.toLowerCase()));
  for (const entry of PRIORITY) {
    if (lc.has(entry.tag)) return entry.color;
  }
  return DEFAULT_COLOR;
}

/** Render radius: grows with degree so hub nodes stand out.
 *  degree^0.7 distributes growth more evenly than sqrt — each new
 *  link stays visibly meaningful even at high connection counts,
 *  reaching ~100px around degree 100 with no upper cap. */
export function radiusForDegree(degree: number): number {
  return NODE_BASE_RADIUS + NODE_DEGREE_COEFF * Math.pow(Math.max(0, degree), 0.7);
}
