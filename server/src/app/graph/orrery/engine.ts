// The Orrery's canvas renderer and its interaction state, with no React
// in it. OrreryCanvas.tsx owns the chrome (panels, search, card) and
// reads this through `subscribe` / `getSnapshot`; every user action goes
// back through the methods returned here.
//
// Nothing simulates: layouts come from ./layout.ts as plain data and a
// transition is an interpolation between two of them, so the picture is
// always the same for the same data and filters.

import type { RelationType } from '@compendium/shared';
import {
  aggregateLinks,
  angDelta,
  campaignLabel,
  clamp,
  computeFocus,
  computeWheel,
  focusTargets,
  groupAnchor,
  KIND_ORDER,
  lerp,
  lerpWheel,
  neighbours,
  pairKey,
  routeWheel,
  TAU,
  wheelTargets,
  type Filters,
  type Focus,
  type Model,
  type ONode,
  type ORel,
  type Target,
  type Wheel,
} from './layout';
import { drawRel as drawRelShared, endMarker as endMarkerShared, pathPts, relColor as relColorShared, strokeBatch as strokeBatchShared, type Stroke } from './draw';
import {
  advanceHover,
  CAPTION_SCALE,
  DRAW_MS,
  drawProgress,
  easeOutCubic,
  HOVER_DOT_GROW,
  HOVER_LABEL_GROW,
  LABEL_SCALE,
  POP_MS,
  popScale,
  reversePath,
  splitBezier,
  staggerDelays,
  STAGGER_MS,
} from './anim';
import {
  KIND_LABEL,
  kindColor,
  kindSingular,
  kindTextColor,
  relLabel,
  type Fonts,
  type Palette,
} from './palette';

export type LinkMode = 'grouped' | 'all';

export type Hover =
  | { type: 'node'; n: ONode }
  | { type: 'sector'; camp: string; all: number };

export interface FocusInfo {
  ring1: number;
  ring2: number;
  overflow: number;
  hidden: { index: number; session: number; filtered: number };
}

export interface Snapshot {
  linkMode: LinkMode;
  showIndex: boolean;
  showSessions: boolean;
  showRelations: boolean;
  kinds: ReadonlySet<string>;
  camps: ReadonlySet<string>;
  relTypes: ReadonlySet<RelationType>;
  drill: string | null;
  focus: ONode | null;
  hist: readonly ONode[];
  hi: number;
  focusInfo: FocusInfo | null;
  /** Whether the scene is the wheel (false while focused). */
  atWheel: boolean;
}

export interface EngineHooks {
  onHover(h: Hover | null, x: number, y: number): void;
  /** The focused note changed (null: back on the wheel). */
  onFocus(n: ONode | null): void;
  /** Opacity (0..1) of the hover card, eased like the hover itself. */
  onTipFade?(a: number): void;
}

export interface EngineOptions {
  worldName: string;
  campNames: Readonly<Record<string, string>>;
  relationTypes: readonly RelationType[];
}

export interface Engine {
  subscribe(fn: () => void): () => void;
  getSnapshot(): Snapshot;
  setPalette(p: Palette, f: Fonts): void;
  resize(w: number, h: number, dpr: number, insetL: number, insetR: number): void;
  setLinkMode(m: LinkMode): void;
  setShowIndex(b: boolean): void;
  setShowSessions(b: boolean): void;
  setShowRelations(b: boolean): void;
  toggleKind(k: string, solo: boolean): void;
  toggleCamp(c: string, solo: boolean): void;
  toggleRelType(t: RelationType): void;
  reset(): void;
  fit(): void;
  toWheel(drill?: string | null): void;
  drill(camp: string): void;
  focusNote(n: ONode, push?: boolean): void;
  histGo(d: number): void;
  histJump(i: number): void;
  /** First scene: every note blooms out of the world at the centre. */
  start(initialFocus: ONode | null): void;
  destroy(): void;
}

/** Per-node hover animation: eased progress `h`, and the clock for the
 *  staggered draw-on of its links. Lives while h > 0 or the node is hovered. */
interface HoverAnim {
  n: ONode;
  /** Raw linear progress; `h` is its easeOutCubic. */
  p: number;
  h: number;
  on: boolean;
  t0: number;
  /** When the pointer left (links freeze at their length and fade). */
  tEnd: number | null;
  near: Set<ONode>;
  /** Start delay (ms) of the link to each neighbour, valid for `arcScene`. */
  arcs: Map<ONode, number>;
  arcScene: Scene | null;
}

interface NodeState {
  cur: Target;
  from: Target;
  to: Target;
  delay: number;
}

type Scene = Wheel | Focus;

const ARC_TOTAL_MS = STAGGER_MS + DRAW_MS + POP_MS;
const easeCubic = (t: number): number => (t <= 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const fract = (x: number): number => x - Math.floor(x);
const trunc = (s: string, n = 28): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createEngine(
  canvas: HTMLCanvasElement,
  model: Model,
  opts: EngineOptions,
  hooks: EngineHooks,
  palette: Palette,
  fontStacks: Fonts,
): Engine {
  const ctx = canvas.getContext('2d')!;
  let C = palette;
  let fonts = fontStacks;
  const { nodes, links, rels, relByPair } = model;
  const campName = (c: string): string => campaignLabel(c, opts.campNames);
  const allKinds = [...KIND_ORDER] as string[];

  // ── state
  const S = {
    linkMode: 'grouped' as LinkMode,
    showIndex: false,
    showSessions: false,
    showRelations: true,
    kinds: new Set<string>(allKinds),
    camps: new Set<string>(model.camps),
    relTypes: new Set<RelationType>(opts.relationTypes),
    drill: null as string | null,
    focus: null as ONode | null,
    hist: [] as ONode[],
    hi: -1,
    hover: null as Hover | null,
  };
  const view = { w: 0, h: 0, cx: 0, cy: 0, R: 300, dpr: 1, il: 8, ir: 8, t: { x: 0, y: 0, k: 1 } };
  const st: NodeState[] = nodes.map(() => ({
    cur: { x: 0, y: 0, r: 0, a: 0 },
    from: { x: 0, y: 0, r: 0, a: 0 },
    to: { x: 0, y: 0, r: 0, a: 0 },
    delay: 0,
  }));
  const cur = (n: ONode): Target => st[n.i]!.cur;
  const to = (n: ONode): Target => st[n.i]!.to;

  let scene: Scene | null = null;
  let fromScene: Scene | null = null;
  const T = { start: 0, dur: 0, t: 1, e: 1 };
  let raf = 0;
  let Z: { from: { x: number; y: number; k: number }; to: { x: number; y: number; k: number }; start: number; dur: number } | null = null;
  let destroyed = false;

  // ── hover animation
  const HA = new Map<ONode, HoverAnim>();
  let hovList: HoverAnim[] = [];
  let hovMax = 0;
  let tNow = performance.now();
  let lastT = -1;
  let tipP = 0;
  let tipSent = -1;
  const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = (): boolean => !!reduceMq?.matches;

  /** Which neighbours a node's links reach in the current scene. */
  function arcNeighbours(n: ONode, sc: Scene): Set<ONode> {
    if (sc.type === 'wheel') {
      const s = neighbours(n);
      s.delete(n);
      return s;
    }
    const out = new Set<ONode>();
    if (n === sc.c) sc.N1.forEach((x) => out.add(x));
    else {
      if (sc.N1s.has(n)) out.add(sc.c);
      for (const [x, y] of sc.e12) {
        if (x === n) out.add(y);
        else if (y === n) out.add(x);
      }
      for (const r of sc.relsOther) {
        if (r.s === n) out.add(r.t);
        else if (r.t === n) out.add(r.s);
      }
    }
    return out;
  }
  function ensureArcs(e: HoverAnim): void {
    if (!scene || e.arcScene === scene) return;
    e.near = arcNeighbours(e.n, scene);
    const list = [...e.near];
    const ang = list.map((x) => Math.atan2(cur(x).y - cur(e.n).y, cur(x).x - cur(e.n).x));
    const delays = staggerDelays(ang);
    e.arcs = new Map(list.map((x, i) => [x, delays[i]!]));
    e.arcScene = scene;
  }
  /** Retarget the hover animations at the node now under the pointer. */
  function syncHover(h: Hover | null): void {
    const n = h?.type === 'node' ? h.n : null;
    const now = performance.now();
    for (const e of HA.values()) {
      if (e.on && e.n !== n) {
        e.on = false;
        e.tEnd = now;
      }
    }
    if (!n) return;
    let e = HA.get(n);
    if (!e) {
      e = { n, p: 0, h: 0, on: true, t0: now, tEnd: null, near: new Set(), arcs: new Map(), arcScene: null };
      HA.set(n, e);
    } else if (!e.on) {
      e.on = true;
      e.tEnd = null;
      // Still fading out: its links are already out, so do not redraw them.
      e.t0 = e.p > 0.01 ? now - ARC_TOTAL_MS : now;
    }
    if (reduced()) e.t0 = now - ARC_TOTAL_MS * 2;
  }
  /** Advance every hover animation to `now`. Returns whether any is still moving. */
  function stepHover(now: number): boolean {
    const dt = lastT < 0 ? 16 : Math.min(now - lastT, 50);
    const rm = reduced();
    let more = false;
    hovMax = 0;
    for (const [n, e] of HA) {
      e.p = advanceHover(e.p, e.on, dt, rm);
      e.h = easeOutCubic(e.p);
      if (!e.on && e.p <= 0) {
        HA.delete(n);
        continue;
      }
      ensureArcs(e);
      if (e.h > hovMax) hovMax = e.h;
      if (e.on ? e.p < 1 || now - e.t0 < ARC_TOTAL_MS : e.p > 0) more = true;
    }
    hovList = [...HA.values()];
    const tipOn = S.hover !== null;
    tipP = advanceHover(tipP, tipOn, dt, rm);
    if (tipOn ? tipP < 1 : tipP > 0) more = true;
    const ta = easeOutCubic(tipP);
    if (ta !== tipSent) {
      tipSent = ta;
      hooks.onTipFade?.(ta);
    }
    return more;
  }
  /** 0..1 growth of the link from `e.n` to `nb`. */
  function arcU(e: HoverAnim, nb: ONode): number {
    return drawProgress((e.tEnd ?? tNow) - e.t0, e.arcs.get(nb) ?? 0);
  }
  /** Alpha of a growing link: full while hovered, fading as the pointer leaves. */
  const arcA = (e: HoverAnim): number => (e.on ? 1 : e.h);
  /** Dot scale: grown if hovered, popped when a link reaches it. */
  function dotScale(n: ONode): number {
    let s = 1;
    for (const e of hovList) {
      if (e.n === n) s = Math.max(s, 1 + (HOVER_DOT_GROW - 1) * e.h);
      else if (e.near.has(n)) {
        const since = (e.tEnd ?? tNow) - e.t0 - (e.arcs.get(n) ?? 0) - DRAW_MS;
        s = Math.max(s, 1 + (popScale(since) - 1) * e.h);
      }
    }
    return s;
  }

  const filters = (): Filters => ({ kinds: S.kinds, camps: S.camps, showIndex: S.showIndex, showSessions: S.showSessions });

  // ── snapshot
  const listeners = new Set<() => void>();
  let snap: Snapshot;
  function makeSnapshot(): Snapshot {
    const F = scene && scene.type === 'focus' ? scene : null;
    return {
      linkMode: S.linkMode,
      showIndex: S.showIndex,
      showSessions: S.showSessions,
      showRelations: S.showRelations,
      kinds: new Set(S.kinds),
      camps: new Set(S.camps),
      relTypes: new Set(S.relTypes),
      drill: S.drill,
      focus: S.focus,
      hist: S.hist.slice(),
      hi: S.hi,
      focusInfo: F ? { ring1: F.N1.length, ring2: F.N2.length, overflow: F.overflow, hidden: F.hidden } : null,
      atWheel: !F,
    };
  }
  function emit(): void {
    snap = makeSnapshot();
    listeners.forEach((fn) => fn());
  }

  // ── transitions
  function go(next: Scene, dur = 950): void {
    const targets: Map<ONode, Target> = next.type === 'wheel' ? wheelTargets(model, next, filters()) : focusTargets(next);
    for (const n of nodes) {
      const s = st[n.i]!;
      s.from = { ...s.cur };
      s.to = targets.get(n) ?? { x: s.cur.x * 1.18, y: s.cur.y * 1.18, r: s.cur.r, a: 0 };
      const th = Math.atan2(s.to.y, s.to.x);
      s.delay = next.type === 'wheel' ? 0.22 * fract((th + Math.PI / 2) / TAU) : 0.18 * clamp(Math.hypot(s.to.x, s.to.y) / view.R);
    }
    fromScene = scene;
    scene = next;
    T.start = performance.now();
    T.dur = dur;
    T.t = dur ? 0 : 1;
    if (!dur) {
      for (const s of st) s.cur = { ...s.to };
      fromScene = null;
      T.e = 1;
    }
    kick();
  }
  function stepNodes(t: number): void {
    for (const s of st) {
      const f = s.from;
      const tt = s.to;
      const local = clamp((t - s.delay) / (1 - 0.22));
      const e = easeCubic(local);
      const fr = Math.hypot(f.x, f.y);
      const tr = Math.hypot(tt.x, tt.y);
      const fth = fr < 0.5 ? Math.atan2(tt.y, tt.x) : Math.atan2(f.y, f.x);
      const tth = tr < 0.5 ? fth : Math.atan2(tt.y, tt.x);
      const th = fth + angDelta(fth, tth) * e;
      const rho = lerp(fr, tr, e);
      s.cur.x = rho * Math.cos(th);
      s.cur.y = rho * Math.sin(th);
      s.cur.r = lerp(f.r, tt.r, e);
      s.cur.a = lerp(f.a, tt.a, e);
    }
  }
  function kick(): void {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }
  function frame(now: number): void {
    raf = 0;
    let more = false;
    if (T.t < 1) {
      T.t = clamp((now - T.start) / T.dur);
      T.e = easeCubic(T.t);
      stepNodes(T.t);
      if (T.t >= 1) fromScene = null;
      else more = true;
    } else T.e = 1;
    if (Z) {
      const q = clamp((now - Z.start) / Z.dur);
      const e = easeCubic(q);
      view.t = { x: lerp(Z.from.x, Z.to.x, e), y: lerp(Z.from.y, Z.to.y, e), k: lerp(Z.from.k, Z.to.k, e) };
      if (q >= 1) Z = null;
      else more = true;
    }
    tNow = now;
    if (stepHover(now)) more = true;
    lastT = more ? now : -1;
    draw();
    if (more) kick();
  }

  // ── view transform
  const SX = (x: number): number => view.t.x + view.t.k * x;
  const SY = (y: number): number => view.t.y + view.t.k * y;
  const dotR = (r: number): number => r * (view.t.k >= 1 ? Math.sqrt(view.t.k) : view.t.k);
  const baseT = (): { x: number; y: number; k: number } => ({ x: view.cx, y: view.cy, k: 1 });
  function fit(animate = true): void {
    if (animate) Z = { from: { ...view.t }, to: baseT(), start: performance.now(), dur: 650 };
    else {
      Z = null;
      view.t = baseT();
    }
    kick();
  }
  function zoomAbout(px: number, py: number, k: number): void {
    const nk = clamp(k, 0.5, 8);
    view.t = { x: px - ((px - view.t.x) * nk) / view.t.k, y: py - ((py - view.t.y) * nk) / view.t.k, k: nk };
  }

  // ── drawing helpers
  const hasLS = 'letterSpacing' in ctx;
  function setFont(f: string, ls = 0): void {
    ctx.font = f;
    if (hasLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`;
  }
  const CAPS = (px = 9, w = 600): string => `${w} ${px}px ${fonts.sans}`;
  const SERIF = (px = 11, style = ''): string => `${style} ${px}px ${fonts.serif}`.trim();

  function dashedCircle(r: number, color: string, alpha: number, dash: number[] = [3, 4], w = 1): void {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(SX(0), SY(0), r * view.t.k, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function arcStroke(r: number, a0: number, a1: number, color: string, alpha: number, dash: number[] = [], w = 1): void {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(SX(0), SY(0), r * view.t.k, a0, a1);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function radialLine(th: number, r0: number, r1: number, color: string, alpha: number, dash: number[] = [], w = 1): void {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(SX(r0 * Math.cos(th)), SY(r0 * Math.sin(th)));
    ctx.lineTo(SX(r1 * Math.cos(th)), SY(r1 * Math.sin(th)));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  /** Small-caps text along an arc, flipped on the lower half so it always
   *  reads left to right. With `measureOnly`, returns the angle it spans. */
  function arcText(text: string, r: number, mid: number, font: string, color: string, alpha: number, ls = 1.6, measureOnly = false): number {
    if (measureOnly) {
      setFont(font, 0);
      let t = 0;
      for (const ch of text) t += ctx.measureText(ch).width + ls;
      return t / (r * view.t.k);
    }
    setFont(font, 0);
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rs = r * view.t.k;
    const ox = SX(0);
    const oy = SY(0);
    const chars = [...text];
    const ws = chars.map((ch) => ctx.measureText(ch).width + ls);
    const total = ws.reduce((a, b) => a + b, 0);
    const flip = Math.sin(mid) > 0.12;
    let a = flip ? mid + total / rs / 2 : mid - total / rs / 2;
    chars.forEach((ch, i) => {
      const w = ws[i]!;
      const ac = flip ? a - w / 2 / rs : a + w / 2 / rs;
      ctx.save();
      ctx.translate(ox + rs * Math.cos(ac), oy + rs * Math.sin(ac));
      ctx.rotate(flip ? ac - Math.PI / 2 : ac + Math.PI / 2);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
      a = flip ? a - w / rs : a + w / rs;
    });
    return total / rs;
  }
  const pathP = (p: readonly number[]): void => pathPts(ctx, p);
  const relColor = (type: RelationType): string => relColorShared(C, type);
  const endMarker = (p: readonly number[], type: RelationType, rTarget: number): void => endMarkerShared(ctx, C, p, type, rTarget);
  const strokeBatch = (list: Stroke[], color: string, width: number, alphaMul = 1, dash: number[] = []): void =>
    strokeBatchShared(ctx, list, color, width, alphaMul, dash);
  function drawRel(r: ORel, p: number[], alpha: number, wMul = 1): void {
    drawRelShared(ctx, C, r, p, alpha, dotR(cur(r.t).r), wMul);
  }
  /** A Relationship drawn out from one end to `u` of its length, in its own
   *  dash and colour. The arrow or diamond shows once the line has arrived,
   *  or at once when it grows out of the target end. */
  function drawRelGrow(r: ORel, p: number[], alpha: number, wMul: number, u: number, fromEnd: boolean): void {
    if (u <= 0.001) return;
    if (u >= 0.999) {
      drawRel(r, p, alpha, wMul);
      return;
    }
    const def = REL_STYLE[r.type];
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = relColor(r.type);
    ctx.lineWidth = def.w * wMul;
    ctx.setLineDash(def.dash);
    ctx.beginPath();
    pathPts(splitBezier(fromEnd ? reversePath(p) : p, u));
    ctx.stroke();
    if (def.dir && fromEnd) endMarker(p, r.type, dotR(cur(r.t).r));
    ctx.setLineDash([]);
  }
  /** The strongest hover whose node is an end of this Relationship. */
  function relHot(r: ORel): { e: HoverAnim; fromEnd: boolean } | null {
    let best: { e: HoverAnim; fromEnd: boolean } | null = null;
    for (const e of hovList) {
      if ((e.n === r.s || e.n === r.t) && (!best || e.h > best.e.h)) best = { e, fromEnd: e.n === r.t };
    }
    return best;
  }
  const relOn = (r: ORel): boolean => S.showRelations && S.relTypes.has(r.type);
  const pt = (n: ONode): [number, number] => [SX(cur(n).x), SY(cur(n).y)];
  /** World-space control points to screen space. */
  const scr = (p: readonly number[]): number[] => p.map((v, i) => (i % 2 ? SY(v) : SX(v)));

  // ── wheel drawing
  /** Where the sector captions sit this frame, so labels stop short of them. */
  const capObs: Array<{ r: number; mid: number; half: number }> = [];
  function drawWheelStructure(W: Wheel, alpha: number): void {
    const g = W.g;
    const k = view.t.k;
    dashedCircle(g.rHub, C.muted, 0.55 * alpha, [2, 3]);
    dashedCircle(g.rOut + 6, C.muted, 0.55 * alpha, [3, 4]);
    dashedCircle((g.rS0 + g.rS1) / 2, C.muted, (S.showSessions ? 0.5 : 0.28) * alpha, [3, 4]);
    const placed: Array<{ mid: number; half: number; lvl: number }> = [];
    capObs.length = 0;
    for (const s of W.sectors.slice().sort((a, b) => b.span - a.span)) {
      const sa = s.alpha * alpha;
      if (sa < 0.01) continue;
      radialLine(s.a0, g.rIn - 6, g.rOut + 6, C.rule, 0.9 * sa);
      radialLine(s.a1, g.rIn - 6, g.rOut + 6, C.rule, 0.9 * sa);
      s.bands.forEach((b, j) => {
        if (j > 0) arcStroke(b.r0, s.a0, s.a1, C.rule, 0.95 * sa * b.alpha, [2, 3]);
      });
      if (S.showSessions && s.sessions.length) {
        const rm = (g.rS0 + g.rS1) / 2;
        arcStroke(rm, s.a0 + 0.01, s.a1 - 0.01, C.ruleDark, 0.75 * sa, [], 1);
        setFont(CAPS(7.5 * CAPTION_SCALE, 500), 0.4);
        ctx.fillStyle = C.muted;
        ctx.globalAlpha = 0.9 * sa;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const L = s.sessions.length;
        s.sessions.forEach((n, i) => {
          if (!(i === 0 || i === L - 1 || (n.ep && n.ep % 5 === 0))) return;
          const th = W.pos.get(n)?.th ?? s.mid;
          const rr = g.rS1 + 11 / k;
          ctx.fillText(String(n.ep ?? '·'), SX(rr * Math.cos(th)), SY(rr * Math.sin(th)));
        });
      }
      const hot = S.hover?.type === 'sector' && S.hover.camp === s.camp;
      const label = `${campName(s.camp).toUpperCase()}  ·  ${s.all}`;
      const font = CAPS(9.5 * CAPTION_SCALE, hot || S.drill === s.camp ? 700 : 600);
      // Small sectors step outward when their name would collide with a neighbour's.
      const half = arcText(label, g.rLab, s.mid, font, '', 0, 1.7, true) / 2 + 0.02;
      let lvl = 0;
      while (lvl < 3 && placed.some((q) => q.lvl === lvl && Math.abs(angDelta(q.mid, s.mid)) < q.half + half)) lvl++;
      placed.push({ mid: s.mid, half, lvl });
      const rl = g.rLab + (lvl * 17) / k;
      capObs.push({ r: rl, mid: s.mid, half });
      if (lvl) radialLine(s.mid, g.rS1 + 6 / k, rl - 7 / k, C.rule, sa);
      arcText(label, rl, s.mid, font, hot ? C.ink : C.inkSoft, sa, 1.7);
      const big = s.span * g.rIn * k > 46 || S.drill === s.camp;
      if (big) {
        for (const b of s.bands) {
          if (b.alpha < 0.05) continue;
          const x = SX(b.ax);
          const y = SY(b.ay);
          const txt = `${KIND_LABEL[b.kind as keyof typeof KIND_LABEL]} ${b.n}`.toUpperCase();
          setFont(CAPS(7.5 * CAPTION_SCALE, 600), 1);
          const w = ctx.measureText(txt).width;
          const left = Math.cos(b.tha) < 0;
          const tx = left ? x - 7 - w : x + 7;
          ctx.globalAlpha = 0.82 * sa * b.alpha;
          ctx.fillStyle = C.parchment;
          ctx.fillRect(tx - 2, y - 6.5, w + 4, 13);
          ctx.globalAlpha = sa * b.alpha;
          ctx.fillStyle = C.muted;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(txt, tx, y + 0.5);
        }
      }
    }
    // The world at the centre.
    setFont(CAPS(10.5 * CAPTION_SCALE, 700), 3);
    ctx.fillStyle = C.ink;
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((opts.worldName || 'World').toUpperCase(), SX(0) + 1.5, SY(0) - 2);
    setFont(SERIF(9.5 * CAPTION_SCALE, 'italic'), 0);
    ctx.fillStyle = C.muted;
    ctx.fillText('the world', SX(0), SY(0) + 14);
    if (hasLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
  }

  function drawWheelEdges(W: Wheel, alpha: number): void {
    const H = hovMax;
    const plain: Stroke[] = [];
    const spokes: Stroke[] = [];
    const grouped: typeof links = [];
    const alphaOf = (l: (typeof links)[number]): number => Math.min(cur(l.s).a, cur(l.t).a) * alpha;
    for (const l of links) {
      const a = l.s;
      const b = l.t;
      const m = alphaOf(l);
      if (m < 0.02) continue;
      if (l.index) {
        if (!S.showIndex) continue;
        spokes.push({ p: [...pt(a), ...pt(b)], a: m });
        continue;
      }
      const individual = S.linkMode === 'all' || (S.drill && (a.campaign === S.drill || b.campaign === S.drill));
      if (individual) {
        plain.push({ p: scr(routeWheel(W, a, b, [cur(a).x, cur(a).y], [cur(b).x, cur(b).y])), a: m });
        continue;
      }
      grouped.push(l);
    }
    const dim = 1 - 0.65 * H;
    strokeBatch(spokes, C.muted, 0.6, 0.3 * dim);
    strokeBatch(plain, C.inkSoft, 0.6, (S.linkMode === 'all' && !S.drill ? 0.09 : 0.16) * dim);
    const bandHov = hovList.filter((e) => e.n.role === 'band').map((e) => ({ key: `${e.n.campaign}|${e.n.bandKind}`, h: e.h }));
    const hb = bandHov.reduce((m, b) => Math.max(m, b.h), 0);
    const aggLabels: Array<[number[], number, number]> = [];
    for (const e of aggregateLinks(grouped, alphaOf)) {
      const pa = groupAnchor(W, e.a);
      const pb = groupAnchor(W, e.b);
      if (!pa || !pb) continue;
      const p = scr(routeWheel(W, e.a, e.b, pa, pb));
      const ga = `${e.a.campaign}|${e.a.kind === 'session' ? 'session' : e.a.kind}`;
      const gb = `${e.b.campaign}|${e.b.kind === 'session' ? 'session' : e.b.kind}`;
      let hot = 0;
      for (const b of bandHov) if (b.key === ga || b.key === gb) hot = Math.max(hot, b.h);
      ctx.lineWidth = 0.5 + Math.sqrt(e.n) * 0.42;
      const base = e.m * 0.3 * (1 - 0.5 * hb) * (1 - hot) * dim;
      if (base > 0.004) {
        ctx.globalAlpha = base;
        ctx.strokeStyle = C.inkSoft;
        ctx.beginPath();
        pathP(p);
        ctx.stroke();
      }
      if (hot > 0.004) {
        ctx.globalAlpha = e.m * 0.85 * hot * dim;
        ctx.strokeStyle = C.candle;
        ctx.beginPath();
        pathP(p);
        ctx.stroke();
        if (hot > 0.5) aggLabels.push([p, e.n, hot]);
      }
    }
    // Relationships, lightly bent toward the centre; the hovered note's grow out of it.
    for (const r of rels) {
      if (!relOn(r)) continue;
      const m = Math.min(cur(r.s).a, cur(r.t).a) * alpha;
      if (m < 0.02) continue;
      const [x0, y0] = [cur(r.s).x, cur(r.s).y];
      const [x1, y1] = [cur(r.t).x, cur(r.t).y];
      const p = [SX(x0), SY(y0), SX(((x0 + x1) / 2) * 0.55), SY(((y0 + y1) / 2) * 0.55), SX(x1), SY(y1)];
      const hot = relHot(r);
      drawRel(r, p, m * 0.34 * (1 - 0.56 * H * (1 - (hot ? hot.e.h : 0))), 0.8);
      if (hot) drawRelGrow(r, p, m * arcA(hot.e), 1.3, arcU(hot.e, hot.fromEnd ? r.s : r.t), hot.fromEnd);
    }
    // The hovered note's own links, bundled, in candlelight, growing out of its dot.
    for (const e of hovList) {
      const hn = e.n;
      if (cur(hn).a <= 0.1) continue;
      const hl: Stroke[] = [];
      for (const nb of hn.adj) {
        if (cur(nb).a < 0.05) continue;
        const u = arcU(e, nb);
        if (u <= 0.001) continue;
        const full =
          hn.isIndex || nb.isIndex
            ? [...pt(hn), ...pt(nb)]
            : scr(routeWheel(W, hn, nb, [cur(hn).x, cur(hn).y], [cur(nb).x, cur(nb).y]));
        hl.push({ p: splitBezier(full, u), a: cur(nb).a * alpha * arcA(e) });
      }
      strokeBatch(hl, C.candle, 1, 0.85);
    }
    if (aggLabels.length) {
      setFont(CAPS(8, 700), 0.5);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const [p, n, hot] of aggLabels) {
        const q =
          p.length === 6
            ? [0.25 * p[0]! + 0.5 * p[2]! + 0.25 * p[4]!, 0.25 * p[1]! + 0.5 * p[3]! + 0.25 * p[5]!]
            : [0.125 * p[0]! + 0.375 * p[2]! + 0.375 * p[4]! + 0.125 * p[6]!, 0.125 * p[1]! + 0.375 * p[3]! + 0.375 * p[5]! + 0.125 * p[7]!];
        const w = ctx.measureText(String(n)).width + 6;
        ctx.globalAlpha = hot;
        ctx.fillStyle = C.vellum;
        ctx.fillRect(q[0]! - w / 2, q[1]! - 6, w, 12);
        ctx.strokeStyle = C.candle;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(q[0]! - w / 2, q[1]! - 6, w, 12);
        ctx.fillStyle = C.ink;
        ctx.fillText(String(n), q[0]!, q[1]! + 0.5);
      }
    }
  }

  // ── focus drawing
  function drawFocusStructure(F: Focus, alpha: number): void {
    const R = F.R;
    dashedCircle(F.r1, C.muted, 0.6 * alpha, [3, 4]);
    dashedCircle((F.rA + F.rB) / 2, C.muted, 0.45 * alpha, [3, 4]);
    dashedCircle(F.rB + 10, C.rule, 0.6 * alpha, [1, 4]);
    for (const s of F.sectors) {
      if (F.sectors.length > 1) radialLine(s.a0 - 0.02, 0.07 * R, F.rB + 10, C.rule, 0.9 * alpha, [2, 4]);
      const lab = KIND_LABEL[s.kind].toUpperCase() + (s.n1 ? `  ${s.n1}` : '');
      const mid = s.a0 + s.span / 2;
      arcText(lab, F.rLab, mid, CAPS(9 * CAPTION_SCALE, 700), kindTextColor(C, s.kind), alpha, 1.6);
      const sub = [s.n2 && `${s.n2} two steps out`, s.over && `+${s.over} more`].filter(Boolean).join(', ');
      // The second line always sits "below" the kind name in reading order.
      if (sub) arcText(sub, Math.sin(mid) > 0.12 ? F.rLab + 16 : F.rLab - 15, mid, SERIF(9.5 * CAPTION_SCALE, 'italic'), C.muted, alpha, 0.3);
    }
  }
  function relLabelText(c: ONode, rs: ORel[]): string {
    return rs.map((r) => relLabel(r.type, r.s === c)).join(', ');
  }
  function drawFocusEdges(F: Focus, alpha: number): void {
    const c = F.c;
    const H = hovMax;
    const pc = pt(c);
    const plain: Stroke[] = [];
    const hot: Stroke[] = [];
    const e12: Stroke[] = [];
    const relSp: Array<[ORel, number[], number]> = [];
    /** The strongest hover on either end of a pair. */
    const entFor = (a: ONode, b: ONode): HoverAnim | null => {
      const ea = HA.get(a);
      const eb = HA.get(b);
      return ea && eb ? (ea.h >= eb.h ? ea : eb) : (ea ?? eb ?? null);
    };
    for (const x of F.N1) {
      const m = Math.min(cur(c).a, cur(x).a) * alpha;
      if (m < 0.02) continue;
      const rs = (relByPair.get(pairKey(c, x)) ?? []).filter(relOn);
      if (rs.length) {
        for (const r of rs) relSp.push([r, r.s === c ? [...pc, ...pt(x)] : [...pt(x), ...pc], m]);
      } else {
        plain.push({ p: [...pc, ...pt(x)], a: m });
        const ent = entFor(c, x);
        if (ent) {
          const fromC = ent.n === c;
          const u = arcU(ent, fromC ? x : c);
          if (u > 0.001) hot.push({ p: splitBezier(fromC ? [...pc, ...pt(x)] : [...pt(x), ...pc], u), a: m * arcA(ent) });
        }
      }
    }
    for (const [x, y] of F.e12) {
      const m = Math.min(cur(x).a, cur(y).a) * alpha;
      if (m < 0.02) continue;
      e12.push({ p: [...pt(x), ...pt(y)], a: m });
      const ent = entFor(x, y);
      if (ent) {
        const fromX = ent.n === x;
        const u = arcU(ent, fromX ? y : x);
        if (u > 0.001) hot.push({ p: splitBezier(fromX ? [...pt(x), ...pt(y)] : [...pt(y), ...pt(x)], u), a: m * arcA(ent) });
      }
    }
    strokeBatch(e12, C.inkSoft, 0.55, 0.13 - 0.07 * H);
    strokeBatch(plain, C.ink, 0.7, 0.42 - 0.2 * H);
    strokeBatch(hot, C.candle, 1.2, 1);
    for (const [r, p, m] of relSp) {
      drawRel(r, p, m, 1.1);
      const h = relHot(r);
      if (h) drawRelGrow(r, p, m * arcA(h.e), 1.5, arcU(h.e, h.fromEnd ? r.s : r.t), h.fromEnd);
    }
    for (const r of F.relsOther) {
      if (!relOn(r)) continue;
      const m = Math.min(cur(r.s).a, cur(r.t).a) * alpha;
      if (m < 0.02) continue;
      const [x0, y0] = [cur(r.s).x, cur(r.s).y];
      const [x1, y1] = [cur(r.t).x, cur(r.t).y];
      const p = [SX(x0), SY(y0), SX(((x0 + x1) / 2) * 0.6), SY(((y0 + y1) / 2) * 0.6), SX(x1), SY(y1)];
      drawRel(r, p, m * 0.55, 1);
      const h = relHot(r);
      if (h) drawRelGrow(r, p, m * arcA(h.e), 1, arcU(h.e, h.fromEnd ? r.s : r.t), h.fromEnd);
    }
  }

  // ── nodes + labels
  function drawNodes(): void {
    const sc = scene!;
    const dimOn = sc.type === 'wheel' && hovMax > 0;
    const order = nodes.filter((n) => cur(n).a > 0.01).sort((a, b) => cur(a).r - cur(b).r);
    for (const n of order) {
      let a = cur(n).a;
      let self = 0;
      let lit = 0;
      for (const e of hovList) {
        if (e.n === n) self = Math.max(self, e.h);
        if (e.n === n || e.near.has(n)) lit = Math.max(lit, e.h);
      }
      if (dimOn) a *= 1 - 0.7 * Math.max(0, hovMax - lit);
      const x = SX(cur(n).x);
      const y = SY(cur(n).y);
      const r = Math.max(0.8, dotR(cur(n).r)) * (hovList.length ? dotScale(n) : 1);
      ctx.globalAlpha = a;
      if (n.isIndex && n.role === 'camp') {
        // Campaign hub: a filled disc in ink with a thin ring around it.
        ctx.fillStyle = C.ink;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = a * 0.7;
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(x, y, r + 2.6, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = a;
      } else if (n.isIndex) {
        ctx.fillStyle = C.vellum;
        ctx.strokeStyle = n.role === 'empty' ? C.muted : C.ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y - r - 0.6);
        ctx.lineTo(x + r + 0.6, y);
        ctx.lineTo(x, y + r + 0.6);
        ctx.lineTo(x - r - 0.6, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = kindColor(C, n.kind);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        if (n.kind === 'session') {
          ctx.strokeStyle = C.vellum;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
      const isC = sc.type === 'focus' && n === sc.c;
      if (self > 0.01 || isC) {
        if (self > 0.01) {
          // A soft candlelight halo that swells with the hover.
          ctx.globalAlpha = cur(n).a * 0.2 * self;
          ctx.fillStyle = C.candle;
          ctx.beginPath();
          ctx.arc(x, y, r + 3.5 + 5 * self, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = cur(n).a * (isC ? 1 : self);
        ctx.strokeStyle = C.candle;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(x, y, r + (n.isIndex && n.role === 'camp' ? 6 : 3.5) + (isC ? 0 : 2.5 * (1 - self)), 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── labels
  const LBL = 10.5 * LABEL_SCALE;
  const CELL = 8;
  function makeGrid(): { test(x: number, y: number): boolean; mark(x: number, y: number, hr: number): void } {
    const cells = new Set<number>();
    const key = (cx: number, cy: number): number => (cx + 512) * 4096 + (cy + 512);
    return {
      test(x, y) {
        const cx = Math.floor(x / CELL);
        const cy = Math.floor(y / CELL);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (cells.has(key(cx + i, cy + j))) return false;
        return true;
      },
      mark(x, y, hr) {
        const cx = Math.floor(x / CELL);
        const cy = Math.floor(y / CELL);
        for (let i = -hr; i <= hr; i++) for (let j = -hr; j <= hr; j++) cells.add(key(cx + i, cy + j));
      },
    };
  }
  type Grid = ReturnType<typeof makeGrid>;
  /** Screen dots labels must not run into (focus scene), hashed by cell. */
  let dotHash: Map<number, Array<[number, number, number, ONode]>> | null = null;
  const DCELL = 24;
  function buildDotHash(list: readonly ONode[]): void {
    dotHash = new Map();
    for (const n of list) {
      if (cur(n).a < 0.3) continue;
      const x = SX(cur(n).x);
      const y = SY(cur(n).y);
      const k = (Math.floor(x / DCELL) + 512) * 4096 + (Math.floor(y / DCELL) + 512);
      const b = dotHash.get(k);
      const rec: [number, number, number, ONode] = [x, y, dotR(cur(n).r) * dotScale(n), n];
      if (b) b.push(rec);
      else dotHash.set(k, [rec]);
    }
  }
  function hitsDot(x: number, y: number, clear: number, self: ONode): boolean {
    if (!dotHash) return false;
    const cx = Math.floor(x / DCELL) + 512;
    const cy = Math.floor(y / DCELL) + 512;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const b = dotHash.get((cx + i) * 4096 + (cy + j));
        if (!b) continue;
        for (const [dx, dy, r, n] of b) if (n !== self && Math.hypot(dx - x, dy - y) < r + clear) return true;
      }
    }
    return false;
  }
  type Ink = Array<[string, number]>;
  /** A name running radially outward from its dot. It is shortened with an
   *  ellipsis to stop before the canvas edge, another label, a caption or
   *  (in the focus scene) a dot; with `force` it ignores the others and may
   *  run inward instead when that leaves more room. */
  function radialLabel(grid: Grid, n: ONode, text: string, px: number, style: string, ink: Ink, force: boolean, dotMul = 1): boolean {
    const x = SX(cur(n).x);
    const y = SY(cur(n).y);
    if (x < -30 || y < -30 || x > view.w + 30 || y > view.h + 30) return false;
    const th0 = Math.atan2(cur(n).y, cur(n).x);
    const off = dotR(cur(n).r) * dotMul + 4;
    setFont(SERIF(px, style), 0);
    const hr = Math.max(1, Math.round(px / 13));
    const minChars = force ? 3 : 5;
    const full = ctx.measureText(text).width;
    let best: { t: string; w: number; dx: number; dy: number } | null = null;
    for (const sgn of force ? [1, -1] : [1]) {
      const dx = Math.cos(th0) * sgn;
      const dy = Math.sin(th0) * sgn;
      const rx = dx > 0 ? (view.w - view.ir - x) / dx : dx < 0 ? (x - view.il) / -dx : Infinity;
      const ry = dy > 0 ? (view.h - 8 - y) / dy : dy < 0 ? (y - 8) / -dy : Infinity;
      let free = Math.min(rx, ry) - off;
      if (!force) {
        for (let d = 0; d <= Math.min(full, free); d += 5) {
          const qx = x + dx * (off + d);
          const qy = y + dy * (off + d);
          if (!grid.test(qx, qy) || hitsDot(qx, qy, px * 0.5, n)) {
            free = Math.min(free, d - 5);
            break;
          }
        }
      }
      let t = text;
      let w = full;
      if (w > free) {
        let lo = minChars;
        let hi = text.length - 1;
        t = '';
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const cand = `${text.slice(0, mid).trimEnd()}…`;
          const cw = ctx.measureText(cand).width;
          if (cw <= free) {
            t = cand;
            w = cw;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        if (!t) continue;
      }
      if (!best || w > best.w) best = { t, w, dx, dy };
    }
    if (!best) return false;
    const { t, w, dx, dy } = best;
    for (let d = 0; d <= w; d += 5) grid.mark(x + dx * (off + d), y + dy * (off + d), hr);
    ctx.save();
    ctx.translate(x, y);
    ctx.textBaseline = 'middle';
    const ang = Math.atan2(dy, dx);
    const left = dx < 0;
    ctx.rotate(left ? ang + Math.PI : ang);
    ctx.textAlign = left ? 'right' : 'left';
    ctx.strokeStyle = C.parchment;
    ctx.lineWidth = Math.max(3, px * 0.22);
    ctx.lineJoin = 'round';
    ctx.globalAlpha = Math.max(...ink.map((i) => i[1]));
    ctx.strokeText(t, left ? -off : off, 0.5);
    for (const [col, al] of ink) {
      if (al < 0.01) continue;
      ctx.globalAlpha = al;
      ctx.fillStyle = col;
      ctx.fillText(t, left ? -off : off, 0.5);
    }
    ctx.restore();
    return true;
  }
  /** The hovered note's name: grows and bolds with the hover. `rest` is how
   *  visible its ordinary label already was before the hover began. */
  function hoverLabel(grid: Grid, e: HoverAnim, rest: number): void {
    const n = e.n;
    if (e.h < 0.02 || cur(n).a <= 0.1) return;
    const px = LBL * (1 + (HOVER_LABEL_GROW - 1) * e.h);
    const wgt = String(Math.round((400 + 300 * e.h) / 100) * 100);
    const vis = Math.max(rest, e.h);
    radialLabel(grid, n, trunc(n.title, 40), px, wgt, [[C.inkSoft, (1 - e.h) * vis], [C.ink, e.h * vis]], true, 1 + (HOVER_DOT_GROW - 1) * e.h);
  }
  function drawLabels(alpha: number): void {
    const sc = scene!;
    const grid = makeGrid();
    dotHash = null;
    const k = view.t.k;
    const hovered = new Set(hovList.map((e) => e.n));
    const done = new Set<ONode>(hovered);
    const baseW = 1 - hovMax;
    if (sc.type === 'wheel') {
      for (const o of capObs) {
        const step = 6 / (o.r * k);
        for (let a = o.mid - o.half; a <= o.mid + o.half; a += step) grid.mark(SX(o.r * Math.cos(a)), SY(o.r * Math.sin(a)), 1);
      }
      let pool = nodes.filter((n) => !n.isIndex && n.kind !== 'session' && cur(n).a > 0.5 && to(n).a > 0.5);
      let basePool = S.drill ? pool.filter((n) => n.campaign === S.drill) : pool;
      basePool = basePool.slice().sort((a, b) => b.degree - a.degree || a.i - b.i);
      const baseBudget = Math.round((S.drill ? 30 : 16) * Math.min(k * k, 9));
      if (hovList.length) {
        const baseTop = new Set(basePool.slice(0, baseBudget));
        for (const e of hovList) hoverLabel(grid, e, baseTop.has(e.n) ? baseW : 0);
        const nbW = new Map<ONode, number>();
        for (const e of hovList) for (const x of e.near) nbW.set(x, Math.max(nbW.get(x) ?? 0, e.h));
        pool = pool.filter((n) => nbW.has(n) && !hovered.has(n)).sort((a, b) => b.degree - a.degree || a.i - b.i);
        let budget = Math.round(12 * Math.min(k * k, 9));
        for (const n of pool) {
          if (budget <= 0) break;
          const w = Math.min(1, nbW.get(n)! + (baseTop.has(n) ? baseW : 0));
          if (radialLabel(grid, n, trunc(n.title), LBL, '', [[C.inkSoft, alpha * w]], false, dotScale(n))) {
            budget--;
            done.add(n);
          }
        }
      }
      if (baseW > 0.02) {
        let budget = baseBudget;
        for (const n of basePool) {
          if (budget <= 0) break;
          if (done.has(n)) continue;
          if (radialLabel(grid, n, trunc(n.title), LBL, '', [[C.inkSoft, alpha * baseW]], false)) budget--;
        }
      }
    } else {
      const F = sc;
      const c = F.c;
      buildDotHash([c, ...F.N1, ...F.N2]);
      const x = SX(cur(c).x);
      const titleFont = SERIF(17 * 1.3, '600');
      const title = trunc(c.title, 34);
      const y = SY(cur(c).y) + dotR(cur(c).r) + 22;
      setFont(titleFont, 0);
      const tw = ctx.measureText(title).width;
      for (let d = -tw / 2 - 8; d <= tw / 2 + 8; d += 8) {
        grid.mark(x + d, y, 2);
        grid.mark(x + d, y + 18, 1);
      }
      // Ring captions, like the poster's distance marks.
      setFont(CAPS(7.5 * CAPTION_SCALE, 600), 1.2);
      ctx.fillStyle = C.muted;
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      for (const [txt, r] of [['1 STEP', F.r1], ['2 STEPS', (F.rA + F.rB) / 2]] as Array<[string, number]>) {
        const tx = SX(0) - 4;
        const ty = SY(r) - 3;
        const cw = ctx.measureText(txt).width;
        ctx.fillText(txt, tx, ty);
        for (let d = 0; d <= cw + 6; d += 8) grid.mark(tx - d, ty - 5, 1);
      }
      // Relationship labels on spokes (skipped, not stacked, when they would collide).
      const placed: number[] = [];
      for (const nb of F.N1) {
        const rs = (relByPair.get(pairKey(c, nb)) ?? []).filter(relOn);
        if (!rs.length || cur(nb).a < 0.3) continue;
        const th = Math.atan2(cur(nb).y, cur(nb).x);
        const dist = Math.hypot(cur(nb).x, cur(nb).y);
        const along = placed.some((t) => Math.abs(angDelta(t, th)) < 0.12) ? 0.7 : 0.5;
        placed.push(th);
        const lx = SX(Math.cos(th) * dist * along);
        const ly = SY(Math.sin(th) * dist * along);
        const txt = relLabelText(c, rs);
        const col = relColorShared(C, rs[0]!.type);
        setFont(SERIF(10 * CAPTION_SCALE, 'italic'), 0);
        const w = ctx.measureText(txt).width;
        const ux = Math.cos(th);
        const uy = Math.sin(th);
        let ok = true;
        for (let d = -w / 2; d <= w / 2 && ok; d += 6) if (!grid.test(lx + ux * d, ly + uy * d)) ok = false;
        if (!ok) continue;
        for (let d = -w / 2; d <= w / 2; d += 6) grid.mark(lx + ux * d, ly + uy * d, 1);
        ctx.save();
        ctx.translate(lx, ly);
        const left = Math.cos(th) < 0;
        ctx.rotate(left ? th + Math.PI : th);
        ctx.globalAlpha = alpha * 0.92;
        ctx.fillStyle = C.vellum;
        ctx.fillRect(-w / 2 - 3, -8, w + 6, 16);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, 0, 0.5);
        ctx.restore();
      }
      for (const e of hovList) if (e.n !== c) hoverLabel(grid, e, F.N1s.has(e.n) ? 1 : 0);
      const ring1 = F.N1.filter((n) => cur(n).a > 0.3 && !hovered.has(n)).sort((a, b) => b.degree - a.degree || a.i - b.i);
      const budget = Math.round(90 * Math.min(k * k, 4));
      ring1.slice(0, budget).forEach((n) => radialLabel(grid, n, trunc(n.title, 26), LBL, '', [[C.inkSoft, alpha]], false, dotScale(n)));
      if (k > 1.6) {
        F.N2.filter((n) => cur(n).a > 0.3 && !hovered.has(n))
          .sort((a, b) => b.degree - a.degree || a.i - b.i)
          .slice(0, Math.round(30 * k))
          .forEach((n) => radialLabel(grid, n, trunc(n.title, 22), 9.5 * 1.25, 'italic', [[C.muted, alpha * 0.9]], false, dotScale(n)));
      }
      // Centre title last so nothing paints over it.
      setFont(titleFont, 0);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = C.parchment;
      ctx.lineWidth = 6;
      ctx.lineJoin = 'round';
      ctx.strokeText(title, x, y);
      ctx.fillStyle = C.ink;
      ctx.fillText(title, x, y);
      setFont(CAPS(8 * CAPTION_SCALE, 600), 1.4);
      ctx.fillStyle = C.muted;
      const sub = `${c.isIndex ? 'INDEX' : kindSingular(c.kind).toUpperCase()} · ${campName(c.campaign).toUpperCase()}`;
      ctx.lineWidth = 4;
      ctx.strokeText(sub, x, y + 18);
      ctx.fillText(sub, x, y + 18);
    }
    if (hasLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
    ctx.globalAlpha = 1;
  }

  function drawLayer(sc: Scene, alpha: number): void {
    if (alpha < 0.01) return;
    if (sc.type === 'wheel') {
      drawWheelStructure(sc, alpha);
      drawWheelEdges(sc, alpha);
    } else {
      drawFocusStructure(sc, alpha);
      drawFocusEdges(sc, alpha);
    }
  }
  function draw(): void {
    if (destroyed) return;
    const { w, h, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.parchment;
    ctx.fillRect(0, 0, w, h);
    if (!scene) return;
    const e = T.e;
    if (fromScene && T.t < 1) {
      if (fromScene.type === 'wheel' && scene.type === 'wheel') drawLayer(lerpWheel(fromScene, scene, e, model.camps), 1);
      else {
        drawLayer(fromScene, 1 - e);
        drawLayer(scene, e);
      }
    } else drawLayer(scene, 1);
    drawNodes();
    drawLabels(fromScene && T.t < 1 ? e * e : 1);
  }

  // ── picking + pointer input
  function pick(mx: number, my: number): Hover | null {
    let best: ONode | null = null;
    let bd = Infinity;
    for (const n of nodes) {
      if (cur(n).a < 0.25 || to(n).a < 0.25) continue;
      const d = Math.hypot(SX(cur(n).x) - mx, SY(cur(n).y) - my);
      const rr = Math.max(dotR(cur(n).r), n.isIndex ? 5 : 2.5) + 3.5;
      if (d < rr && d < bd) {
        bd = d;
        best = n;
      }
    }
    if (best) return { type: 'node', n: best };
    if (scene && scene.type === 'wheel') {
      const wx = (mx - view.t.x) / view.t.k;
      const wy = (my - view.t.y) / view.t.k;
      const rho = Math.hypot(wx, wy);
      const th = Math.atan2(wy, wx);
      const g = scene.g;
      if (rho > g.rS1 + 4 && rho < g.R * 1.03) {
        for (const s of scene.sectors) {
          const d = (((th - s.a0) % TAU) + TAU) % TAU;
          if (d <= s.span) return { type: 'sector', camp: s.camp, all: s.all };
        }
      }
    }
    return null;
  }
  const sameHover = (a: Hover | null, b: Hover | null): boolean => {
    if (!a || !b) return a === b;
    if (a.type === 'node') return b.type === 'node' && a.n === b.n;
    return b.type === 'sector' && a.camp === b.camp;
  };

  const ptrs = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  let suppressClick = false;
  let pinch: { d: number; k: number } | null = null;
  const local = (ev: PointerEvent | MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const setHover = (h: Hover | null, x: number, y: number): void => {
    const same = sameHover(h, S.hover);
    S.hover = h;
    canvas.style.cursor = h ? 'pointer' : 'default';
    hooks.onHover(h, x, y);
    if (!same) {
      syncHover(h);
      kick();
    }
  };

  function onPointerDown(ev: PointerEvent): void {
    if (ev.button) return;
    const p = local(ev);
    ptrs.set(ev.pointerId, p);
    canvas.setPointerCapture(ev.pointerId);
    Z = null;
    // Touch fires no click after a pan or pinch, so a stale flag would eat the next tap.
    if (ptrs.size === 1) suppressClick = false;
    if (ptrs.size === 1) drag ={ x: p.x, y: p.y, tx: view.t.x, ty: view.t.y, moved: false };
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, k: view.t.k };
      drag = null;
    }
  }
  function onPointerMove(ev: PointerEvent): void {
    const p = local(ev);
    if (!ptrs.has(ev.pointerId)) {
      if (ev.pointerType === 'mouse') setHover(pick(p.x, p.y), p.x, p.y);
      return;
    }
    ptrs.set(ev.pointerId, p);
    if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
      zoomAbout((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, (pinch.k * d) / pinch.d);
      suppressClick = true;
      kick();
    } else if (drag) {
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        setHover(null, p.x, p.y);
      }
      if (drag.moved) {
        view.t = { x: drag.tx + dx, y: drag.ty + dy, k: view.t.k };
        suppressClick = true;
        kick();
      }
    }
  }
  function onPointerUp(ev: PointerEvent): void {
    ptrs.delete(ev.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size === 0) drag = null;
    else if (ptrs.size === 1) {
      const [p] = [...ptrs.values()];
      drag = { x: p!.x, y: p!.y, tx: view.t.x, ty: view.t.y, moved: true };
    }
  }
  function onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    Z = null;
    const p = local(ev);
    const d = -ev.deltaY * (ev.deltaMode === 1 ? 0.05 : ev.deltaMode ? 1 : 0.002) * (ev.ctrlKey ? 10 : 1);
    zoomAbout(p.x, p.y, view.t.k * 2 ** d);
    kick();
  }
  function onLeave(): void {
    if (ptrs.size) return;
    setHover(null, 0, 0);
  }
  function onClick(ev: MouseEvent): void {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const p = local(ev);
    const h = pick(p.x, p.y);
    if (!h) return;
    if (h.type === 'sector') return api.drill(h.camp);
    if (scene?.type === 'wheel' && h.n.isIndex && h.n.role === 'camp') return api.drill(h.n.campaign);
    api.focusNote(h.n);
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('click', onClick);

  // ── navigation
  function relayout(): void {
    if (!scene) return;
    if (scene.type === 'wheel') go(computeWheel(model, filters(), view.R, S.drill), 750);
    else go(computeFocus(model, filters(), S.focus!, view.R), 650);
    emit();
  }
  function setFocus(n: ONode | null): void {
    S.focus = n;
    hooks.onFocus(n);
  }

  const api: Engine = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => snap,
    setPalette(p, f) {
      C = p;
      fonts = f;
      kick();
    },
    resize(w, h, dpr, insetL, insetR) {
      const sized = view.w > 0;
      const { cx: oldCx, cy: oldCy } = view;
      view.w = w;
      view.h = h;
      view.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      view.il = Math.max(8, insetL - 20);
      view.ir = Math.max(8, insetR - 20);
      view.cx = insetL + (w - insetL - insetR) / 2;
      view.cy = h / 2 + 10;
      view.R = Math.max(170, Math.min((w - insetL - insetR) / 2 - 10, h / 2 - 40));
      Z = null;
      // Keep the user's zoom and pan across resizes, shifted with the centre.
      view.t = sized ? { x: view.t.x + view.cx - oldCx, y: view.t.y + view.cy - oldCy, k: view.t.k } : baseT();
      if (scene) {
        go(scene.type === 'wheel' ? computeWheel(model, filters(), view.R, S.drill) : computeFocus(model, filters(), S.focus!, view.R), 0);
        emit();
      }
      draw();
    },
    setLinkMode(m) {
      S.linkMode = m;
      emit();
      kick();
    },
    setShowIndex(b) {
      S.showIndex = b;
      relayout();
    },
    setShowSessions(b) {
      S.showSessions = b;
      relayout();
    },
    setShowRelations(b) {
      S.showRelations = b;
      emit();
      kick();
    },
    toggleKind(k, solo) {
      if (solo) S.kinds = new Set([k]);
      else if (S.kinds.has(k)) S.kinds.delete(k);
      else S.kinds.add(k);
      if (!S.kinds.size) S.kinds = new Set(allKinds);
      relayout();
    },
    toggleCamp(c, solo) {
      if (solo) S.camps = new Set([c]);
      else if (S.camps.has(c)) S.camps.delete(c);
      else S.camps.add(c);
      if (!S.camps.size) S.camps = new Set(model.camps);
      if (S.drill && !S.camps.has(S.drill)) S.drill = null;
      if (S.focus && !S.camps.has(S.focus.campaign) && scene?.type === 'focus') {
        // A focused note whose campaign was switched off: fall back to the wheel.
        S.hist = [];
        S.hi = -1;
        setFocus(null);
        go(computeWheel(model, filters(), view.R, S.drill), 750);
        fit();
        emit();
        return;
      }
      relayout();
    },
    toggleRelType(t) {
      if (S.relTypes.has(t)) S.relTypes.delete(t);
      else S.relTypes.add(t);
      emit();
      kick();
    },
    reset() {
      S.kinds = new Set(allKinds);
      S.camps = new Set(model.camps);
      S.relTypes = new Set(opts.relationTypes);
      S.showRelations = true;
      api.toWheel(null);
    },
    fit: () => fit(),
    toWheel(drillCamp = S.drill) {
      S.drill = drillCamp;
      setFocus(null);
      go(computeWheel(model, filters(), view.R, S.drill));
      fit();
      emit();
    },
    drill(camp) {
      if (scene?.type !== 'wheel') return api.toWheel(camp);
      S.drill = S.drill === camp ? null : camp;
      go(computeWheel(model, filters(), view.R, S.drill), 1000);
      fit();
      emit();
    },
    focusNote(n, push = true) {
      if (push) {
        S.hist = S.hist.slice(0, S.hi + 1);
        if (S.hist[S.hist.length - 1] !== n) S.hist.push(n);
        S.hi = S.hist.length - 1;
      }
      setFocus(n);
      setHover(null, 0, 0);
      go(computeFocus(model, filters(), n, view.R), scene?.type === 'focus' ? 850 : 1050);
      fit();
      emit();
    },
    histGo(d) {
      api.histJump(S.hi + d);
    },
    histJump(i) {
      if (i < 0 || i >= S.hist.length) return;
      S.hi = i;
      api.focusNote(S.hist[i]!, false);
    },
    start(initialFocus) {
      if (initialFocus) {
        S.hist = [initialFocus];
        S.hi = 0;
        setFocus(initialFocus);
        go(computeFocus(model, filters(), initialFocus, view.R), 1500);
      } else {
        go(computeWheel(model, filters(), view.R, null), 1500);
      }
      fit(false);
      emit();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('click', onClick);
      listeners.clear();
    },
  };
  snap = makeSnapshot();
  return api;
}

