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
  { tag: 'villain', color: 'wine' },
  { tag: 'location', color: 'moss' },
  { tag: 'ally', color: 'sage' },
  { tag: 'official', color: 'sage' },
  { tag: 'session', color: 'embers' },
];

const DEFAULT_COLOR = 'ink-soft';

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

/** Campaign-root / folder-anchor index notes.
 *  These are the `index.md` (or `_index.md` / `README.md`) files at the
 *  root of a campaign folder — created by the import pipeline and used
 *  as the canonical "this campaign exists" record. They typically have
 *  a low link degree (the canonical sub-folder notes link inward, not
 *  the root itself), so without a special-case they render as
 *  invisible specks. Both graph views identify them via this helper. */
export function isAnchorPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('/index.md') ||
    lower.endsWith('/_index.md') ||
    lower.endsWith('/readme.md')
  );
}

/** Anchor sizing — campaign roots should always read as the biggest
 *  sphere in their cluster regardless of degree. We achieve this with:
 *   - a multiplier on the degree-derived radius (so an anchor with high
 *     degree still scales up further), and
 *   - an absolute floor (so a degree-0 anchor still dwarfs leaf nodes). */
export const ANCHOR_RADIUS_BOOST = 4.0;
export const ANCHOR_RADIUS_FLOOR = 60; // pixels in 2D; mirrored in 3D as /4 → 15 world units

/** Final render radius for a graph node, including the anchor boost.
 *  Use this everywhere instead of bare `radiusForDegree` so anchor
 *  notes stay visible even with degree 0 *and* always read as the
 *  biggest sphere in their cluster. */
export function nodeRenderRadius(path: string, degree: number): number {
  const base = radiusForDegree(degree);
  if (!isAnchorPath(path)) return base;
  return Math.max(ANCHOR_RADIUS_FLOOR, base * ANCHOR_RADIUS_BOOST);
}

/** Extract a stable cluster identifier from a note path using up to 3 segments,
 *  so sub-folders (characters, enemies, sessions) cluster separately.
 *  e.g. "campaigns/dragon-heist/characters/beholder" → "campaigns/dragon-heist/characters" */
export function clusterKey(path: string): string {
  const parts = path.split('/');
  return parts.slice(0, 3).join('/') || '__root__';
}

/** Build a deterministic per-node seed position that is cluster-aware.
 *  Nodes in the same folder start near each other so FA2 refines
 *  existing structure rather than discovering it from scratch.
 *
 *  Cluster centres sit on a circle; nodes within each cluster are placed
 *  on a Fibonacci disc (golden-angle spiral) for uniform density. */
export function clusterSeedPositions(
  nodes: ReadonlyArray<{ id: string }>,
  spacing = 7,
): Map<string, { x: number; y: number }> {
  const clusterMap = new Map<string, string[]>();
  for (const n of nodes) {
    const key = clusterKey(n.id);
    const bucket = clusterMap.get(key);
    if (bucket) bucket.push(n.id);
    else clusterMap.set(key, [n.id]);
  }

  const clusters = [...clusterMap.entries()];
  const C = clusters.length;
  const galaxyRadius = C <= 1 ? 0 : spacing * Math.sqrt(C);
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const positions = new Map<string, { x: number; y: number }>();

  clusters.forEach(([, ids], ci) => {
    const angle = (2 * Math.PI * ci) / Math.max(1, C);
    const cx = galaxyRadius * Math.cos(angle);
    const cy = galaxyRadius * Math.sin(angle);
    const size = ids.length;
    ids.forEach((id, i) => {
      const r = size <= 1 ? 0 : 1.2 * Math.sqrt(i / (size - 1));
      const theta = i * GOLDEN_ANGLE;
      positions.set(id, { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) });
    });
  });

  return positions;
}
