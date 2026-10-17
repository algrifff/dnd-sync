// Timing math for the Orrery's hover animation, pure so it can be tested
// without a canvas: easing, per-node hover progress, the staggered
// draw-on of a node's links, the neighbour "pop", and the de Casteljau
// split that lets a curved link grow along its actual curve.

export const HOVER_IN_MS = 200;
export const HOVER_OUT_MS = 150;
/** Spread of the per-link start delays around the hovered node. */
export const STAGGER_MS = 160;
export const DRAW_MS = 280;
export const POP_MS = 180;

/** Type scale for the "much bigger names" pass. */
export const LABEL_SCALE = 1.5;
export const CAPTION_SCALE = 1.2;
export const HOVER_LABEL_GROW = 1.35;
export const HOVER_DOT_GROW = 1.6;
export const NEIGHBOUR_DOT_GROW = 1.15;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export const easeOutCubic = (t: number): number => 1 - (1 - clamp01(t)) ** 3;

/** Move a raw 0..1 hover progress toward hovered (1) or not (0). Progress
 *  is linear in time at the in/out rate; the eased value `h` is
 *  `easeOutCubic(progress)`, so reversing mid-way is continuous. */
export function advanceHover(p: number, hovered: boolean, dtMs: number, reduced = false): number {
  if (reduced) return hovered ? 1 : 0;
  const step = dtMs / (hovered ? HOVER_IN_MS : HOVER_OUT_MS);
  return clamp01(hovered ? p + step : p - step);
}

/** Start delays (ms, 0..spread) for links leaving a node at the given
 *  angles, ordered by angle clockwise from twelve o'clock so the links
 *  unfurl around the node. Returned in the order of `angles`. */
export function staggerDelays(angles: readonly number[], spread = STAGGER_MS): number[] {
  const TAU = Math.PI * 2;
  const key = angles.map((a) => (((a + Math.PI / 2) % TAU) + TAU) % TAU);
  const order = key.map((_, i) => i).sort((a, b) => key[a]! - key[b]! || a - b);
  const out = new Array<number>(angles.length).fill(0);
  const last = Math.max(1, angles.length - 1);
  order.forEach((idx, rank) => {
    out[idx] = (rank / last) * spread;
  });
  return out;
}

/** 0..1 growth of one link `elapsedMs` after the hover began. */
export function drawProgress(elapsedMs: number, delayMs: number, durMs = DRAW_MS): number {
  return easeOutCubic((elapsedMs - delayMs) / durMs);
}

/** Dot scale as a link arrives: 1.0, 1.25, then 1.15 over POP_MS.
 *  `sinceMs` is the time since the line reached the dot (negative: not yet). */
export function popScale(sinceMs: number): number {
  if (sinceMs <= 0) return 1;
  const t = clamp01(sinceMs / POP_MS);
  if (t < 0.5) return 1 + 0.25 * easeOutCubic(t / 0.5);
  return 1.25 - 0.1 * easeOutCubic((t - 0.5) / 0.5);
}

/** A control-point list: 4 numbers (line), 6 (quadratic) or 8 (cubic). */
export type PathPts = readonly number[];

/** The part of a Bezier path from 0 to `t`, by de Casteljau: same degree,
 *  so it follows the real curve. t >= 1 returns the path unchanged. */
export function splitBezier(p: PathPts, t: number): number[] {
  if (t >= 1) return p.slice();
  const u = t < 0 ? 0 : t;
  const mix = (a: number, b: number): number => a + (b - a) * u;
  if (p.length === 4) return [p[0]!, p[1]!, mix(p[0]!, p[2]!), mix(p[1]!, p[3]!)];
  const ax = mix(p[0]!, p[2]!);
  const ay = mix(p[1]!, p[3]!);
  const bx = mix(p[2]!, p[4]!);
  const by = mix(p[3]!, p[5]!);
  if (p.length === 6) return [p[0]!, p[1]!, ax, ay, mix(ax, bx), mix(ay, by)];
  const cx = mix(p[4]!, p[6]!);
  const cy = mix(p[5]!, p[7]!);
  const dx = mix(ax, bx);
  const dy = mix(ay, by);
  const ex = mix(bx, cx);
  const ey = mix(by, cy);
  return [p[0]!, p[1]!, ax, ay, dx, dy, mix(dx, ex), mix(dy, ey)];
}

/** The same path walked the other way, so it can grow from its far end. */
export function reversePath(p: PathPts): number[] {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i]!, p[i + 1]!);
  return out;
}

/** Point on a path at parameter t. */
export function bezierAt(p: PathPts, t: number): [number, number] {
  const q = splitBezier(p, t);
  return [q[q.length - 2]!, q[q.length - 1]!];
}
