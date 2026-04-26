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

/** Three-tier anchor sizing:
 *   - tier 1 ("campaign"): top-level section roots — `Campaigns/<slug>/
 *     index.md`, `World Lore/index.md`, `World Lore/<section>/index.md`.
 *     Path depth ≤ 3 segments.
 *   - tier 2 ("canonical"): canonical sub-folder roots inside a
 *     section — `Campaigns/<slug>/Characters/index.md`,
 *     `Campaigns/<slug>/Adventure Log/index.md`, etc. Path depth ≥ 4.
 *   - null: not an anchor.
 *
 *  Each tier carries its own multiplier + absolute floor so the
 *  visual hierarchy holds even when none of the nodes have many
 *  links — a degree-0 campaign root still dwarfs a degree-0
 *  canonical root, which still dwarfs leaf entities. */
export type AnchorTier = 'campaign' | 'canonical' | null;

export function anchorTier(path: string): AnchorTier {
  if (!isAnchorPath(path)) return null;
  // /<root>/<index>.md is 2 segments → campaign tier (top-level lore root).
  // /<root>/<parent>/<index>.md is 3 segments → also campaign tier
  // (campaign root or sub-section root).
  // /<root>/<parent>/<sub>/<index>.md is 4 segments → canonical tier
  // (canonical sub-folder root: Characters / Loot / Adventure Log / …).
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 3 ? 'campaign' : 'canonical';
}

const TIER_BOOSTS = { campaign: 4.0, canonical: 3.0 } as const;
const TIER_FLOORS = { campaign: 60, canonical: 40 } as const;

// Kept for any older consumer; reflects the campaign tier.
export const ANCHOR_RADIUS_BOOST = TIER_BOOSTS.campaign;
export const ANCHOR_RADIUS_FLOOR = TIER_FLOORS.campaign;

/** Final render radius for a graph node, including the anchor boost.
 *  Use this everywhere instead of bare `radiusForDegree` so anchor
 *  notes stay visible even with degree 0 and the tier ordering is
 *  preserved (campaign root > canonical root > leaf). */
export function nodeRenderRadius(path: string, degree: number): number {
  const base = radiusForDegree(degree);
  const tier = anchorTier(path);
  if (!tier) return base;
  return Math.max(TIER_FLOORS[tier], base * TIER_BOOSTS[tier]);
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
