// Canvas drawing primitives shared by the full Orrery (engine.ts) and the
// note sidebar's compact view (mini.ts). They take the 2D context and the
// palette explicitly so both renderers draw typed Relationships and
// batched strokes identically.

import type { RelationType } from '@compendium/shared';
import { clamp, type ORel } from './layout';
import { REL_STYLE, type Palette } from './palette';

export type Stroke = { p: number[]; a: number };

/** Add a line, quadratic (6 numbers) or cubic (8) segment to the open path. */
export function pathPts(ctx: CanvasRenderingContext2D, p: readonly number[]): void {
  ctx.moveTo(p[0]!, p[1]!);
  if (p.length === 4) ctx.lineTo(p[2]!, p[3]!);
  else if (p.length === 6) ctx.quadraticCurveTo(p[2]!, p[3]!, p[4]!, p[5]!);
  else ctx.bezierCurveTo(p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!);
}

/** Stroke many paths in one colour, one draw call per alpha bucket. */
export function strokeBatch(
  ctx: CanvasRenderingContext2D,
  list: Stroke[],
  color: string,
  width: number,
  alphaMul = 1,
  dash: number[] = [],
): void {
  if (!list.length) return;
  const buckets = new Map<number, number[][]>();
  for (const e of list) {
    const b = Math.round(e.a * 24);
    if (b <= 0) continue;
    const bucket = buckets.get(b);
    if (bucket) bucket.push(e.p);
    else buckets.set(b, [e.p]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  buckets.forEach((ps, b) => {
    ctx.globalAlpha = clamp((b / 24) * alphaMul);
    ctx.beginPath();
    for (const p of ps) pathPts(ctx, p);
    ctx.stroke();
  });
  ctx.setLineDash([]);
}

export const relColor = (C: Palette, type: RelationType): string => C[REL_STYLE[type].color];

/** Arrow chevron or an "owns" diamond at the target end of a relation. */
export function endMarker(ctx: CanvasRenderingContext2D, C: Palette, p: readonly number[], type: RelationType, rTarget: number): void {
  const def = REL_STYLE[type];
  const n = p.length;
  const ex = p[n - 2]!;
  const ey = p[n - 1]!;
  const px = p[n - 4]!;
  const py = p[n - 3]!;
  let dx = ex - px;
  let dy = ey - py;
  const L = Math.hypot(dx, dy) || 1;
  dx /= L;
  dy /= L;
  const bx = ex - dx * (rTarget + 2.5);
  const by = ey - dy * (rTarget + 2.5);
  ctx.setLineDash([]);
  ctx.beginPath();
  if (def.diamond) {
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - dx * 4 - dy * 2.6, by - dy * 4 + dx * 2.6);
    ctx.lineTo(bx - dx * 8, by - dy * 8);
    ctx.lineTo(bx - dx * 4 + dy * 2.6, by - dy * 4 - dx * 2.6);
    ctx.closePath();
    ctx.fillStyle = relColor(C, type);
    ctx.fill();
  } else {
    ctx.moveTo(bx - dx * 5 - dy * 3, by - dy * 5 + dx * 3);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx - dx * 5 + dy * 3, by - dy * 5 - dx * 3);
    ctx.stroke();
  }
}

/** One typed Relationship in its Orrery style (colour, dash, arrow head). */
export function drawRel(
  ctx: CanvasRenderingContext2D,
  C: Palette,
  r: ORel,
  p: number[],
  alpha: number,
  rTarget: number,
  wMul = 1,
): void {
  const def = REL_STYLE[r.type];
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = relColor(C, r.type);
  ctx.lineWidth = def.w * wMul;
  ctx.setLineDash(def.dash);
  ctx.beginPath();
  pathPts(ctx, p);
  ctx.stroke();
  if (def.dir) endMarker(ctx, C, p, r.type, rTarget);
  ctx.setLineDash([]);
}
