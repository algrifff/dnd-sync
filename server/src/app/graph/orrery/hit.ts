// Pointer hit-testing for the Orrery, in screen pixels and with no canvas,
// so the engine and the tests share it. A path is the same flat point list
// the renderer strokes (see draw.ts#pathPts): a line (4 numbers), a
// quadratic (6) or a cubic (8).

/** How far (px) from a Relationship's line the pointer may be and still pick it. */
export const REL_HIT_PX = 6;

/** Straight pieces a curve is cut into when measuring distance to it. */
const SAMPLES = 16;

export interface NodeHit<N> {
  x: number;
  y: number;
  /** Pick radius in px. */
  r: number;
  item: N;
}

export interface PathHit<R> {
  p: readonly number[];
  item: R;
}

export type Picked<N, R> = { type: 'node'; item: N } | { type: 'rel'; item: R } | null;

function distToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function pointAt(p: readonly number[], t: number): [number, number] {
  const u = 1 - t;
  if (p.length === 6) {
    return [u * u * p[0]! + 2 * u * t * p[2]! + t * t * p[4]!, u * u * p[1]! + 2 * u * t * p[3]! + t * t * p[5]!];
  }
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p[0]! + b * p[2]! + c * p[4]! + d * p[6]!, a * p[1]! + b * p[3]! + c * p[5]! + d * p[7]!];
}

/** Distance (px) from a point to a line or Bézier path. Curves are measured
 *  against a 16-piece polyline, close enough at a few pixels' tolerance. */
export function distToPath(p: readonly number[], x: number, y: number): number {
  if (p.length === 4) return distToSegment(x, y, p[0]!, p[1]!, p[2]!, p[3]!);
  let best = Infinity;
  let px = p[0]!;
  let py = p[1]!;
  for (let i = 1; i <= SAMPLES; i++) {
    const [qx, qy] = pointAt(p, i / SAMPLES);
    best = Math.min(best, distToSegment(x, y, px, py, qx, qy));
    px = qx;
    py = qy;
  }
  return best;
}

/** Whether (x, y) is outside the control points' box grown by `tol`. A
 *  Bézier lies inside the hull of its control points, so nothing near the
 *  curve is ever skipped. */
function outsideBox(p: readonly number[], x: number, y: number, tol: number): boolean {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]!);
    x1 = Math.max(x1, p[i]!);
    y0 = Math.min(y0, p[i + 1]!);
    y1 = Math.max(y1, p[i + 1]!);
  }
  return x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol;
}

/** The nearest node whose pick radius covers the point. */
export function pickNode<N>(nodes: Iterable<NodeHit<N>>, x: number, y: number): N | null {
  let best: N | null = null;
  let bd = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < n.r && d < bd) {
      bd = d;
      best = n.item;
    }
  }
  return best;
}

/** The path nearest the point, if any is within `tol` px. */
export function pickPath<R>(paths: Iterable<PathHit<R>>, x: number, y: number, tol = REL_HIT_PX): R | null {
  let best: R | null = null;
  let bd = tol;
  for (const h of paths) {
    if (outsideBox(h.p, x, y, tol)) continue;
    const d = distToPath(h.p, x, y);
    if (d <= bd) {
      bd = d;
      best = h.item;
    }
  }
  return best;
}

/** What the pointer is on: a node wins over a Relationship line under it. */
export function pickAt<N, R>(nodes: Iterable<NodeHit<N>>, paths: Iterable<PathHit<R>>, x: number, y: number, tol = REL_HIT_PX): Picked<N, R> {
  const n = pickNode(nodes, x, y);
  if (n !== null) return { type: 'node', item: n };
  const r = pickPath(paths, x, y, tol);
  return r !== null ? { type: 'rel', item: r } : null;
}

/** `hit` first, then every other Relationship between the same two notes,
 *  in either direction: they share one drawn path, so hovering it is
 *  hovering all of them. Each type and direction is listed once, since a
 *  scene change draws the outgoing and incoming scenes together. */
export function relsOnPair<R extends { s: unknown; t: unknown; type: unknown }>(all: Iterable<R>, hit: R): R[] {
  const key = (r: R): string => `${String(r.type)}|${r.s === hit.s ? '>' : '<'}`;
  const seen = new Set([key(hit)]);
  const out = [hit];
  for (const r of all) {
    const onPair = (r.s === hit.s && r.t === hit.t) || (r.s === hit.t && r.t === hit.s);
    if (!onPair || seen.has(key(r))) continue;
    seen.add(key(r));
    out.push(r);
  }
  return out;
}
