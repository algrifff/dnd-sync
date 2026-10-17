// The note sidebar's compact Satellites view: the open note at the centre
// and its direct links around it in one sector per kind. It reuses the
// Orrery's focus layout (layout.ts, compact mode), palette (palette.ts) and
// stroke primitives (draw.ts); only the small scene itself lives here.
//
// It draws on demand (resize, theme change) and runs a requestAnimationFrame
// loop only while a hover is easing in or out.

import { clamp, computeFocus, focusTargets, KIND_ORDER, pairKey, TAU, type Filters, type Focus, type Model, type ONode, type ORel } from './layout';
import { advanceHover, easeOutCubic, HOVER_DOT_GROW, NEIGHBOUR_DOT_GROW } from './anim';
import { drawRel, strokeBatch, type Stroke } from './draw';
import { kindColor, type Fonts, type Palette } from './palette';

export interface MiniHooks {
  /** A satellite was clicked. The centre is not a target. */
  onOpen(n: ONode): void;
}

export interface Mini {
  setPalette(p: Palette, f: Fonts): void;
  resize(side: number, dpr: number): void;
  destroy(): void;
}

/** Largest neighbours that get a permanent label when they fit. */
const LABELLED = 4;
/** Links between two neighbours drawn as faint chords, at most. */
const MAX_CHORDS = 400;

/** Labels here are a little bigger than before (10px), not the full wheel scale: the view is small. */
const LABEL_PX = 12;

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Everything visible: the sidebar shows what the note links to, whatever it is. */
export function miniFilters(model: Model): Filters {
  return { kinds: new Set<string>(KIND_ORDER), camps: new Set(model.camps), showIndex: true, showSessions: true };
}

interface Spot {
  x: number;
  y: number;
  r: number;
}

export function createMini(canvas: HTMLCanvasElement, model: Model, centre: ONode, palette: Palette, fontStacks: Fonts, hooks: MiniHooks): Mini {
  const ctx = canvas.getContext('2d')!;
  let C = palette;
  let fonts = fontStacks;
  let side = 0;
  let F: Focus | null = null;
  let spots = new Map<ONode, Spot>();
  let hover: ONode | null = null;
  let destroyed = false;
  // Raw hover progress per node (eased on read); an entry lives until it is back at 0.
  const hp = new Map<ONode, number>();
  let raf = 0;
  let lastT = -1;
  const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const hs = (n: ONode): number => easeOutCubic(hp.get(n) ?? 0);
  const hMax = (): number => {
    let m = 0;
    for (const n of hp.keys()) m = Math.max(m, hs(n));
    return m;
  };
  /** How lit a node is: itself hovered, or next to a hovered node. */
  const lit = (n: ONode): number => {
    let m = hs(n);
    for (const o of hp.keys()) if (o !== n && (o.adj.has(n) || n.adj.has(o))) m = Math.max(m, hs(o));
    return m;
  };
  function step(now: number): void {
    raf = 0;
    const dt = lastT < 0 ? 16 : Math.min(now - lastT, 50);
    let more = false;
    for (const [n, p] of hp) {
      const q = advanceHover(p, n === hover, dt, !!reduceMq?.matches);
      if (q <= 0 && n !== hover) hp.delete(n);
      else {
        hp.set(n, q);
        if (n === hover ? q < 1 : q > 0) more = true;
      }
    }
    lastT = more ? now : -1;
    draw();
    if (more) kick();
  }
  function kick(): void {
    if (!raf && !destroyed) raf = requestAnimationFrame(step);
  }

  function layout(): void {
    const R = side / 2 - 12;
    const f = computeFocus(model, miniFilters(model), centre, R, { compact: true });
    const dense = f.N1.length > 40 ? 0.62 : 1;
    spots = new Map();
    focusTargets(f).forEach((t, n) => {
      spots.set(n, { x: side / 2 + t.x, y: side / 2 + t.y, r: n === centre ? Math.min(9, t.r) : Math.min(7, t.r * dense) });
    });
    F = f;
  }

  function draw(): void {
    if (destroyed || !F || !side) return;
    const f = F;
    ctx.setTransform(canvas.width / side, 0, 0, canvas.height / side, 0, 0);
    ctx.clearRect(0, 0, side, side);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    const mid = side / 2;
    const at = (n: ONode): Spot => spots.get(n)!;

    // Sector dividers and the first ring, as quiet structure.
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.globalAlpha = 0.9;
    if (f.sectors.length > 1) {
      for (const s of f.sectors) {
        const a = s.a0 - 0.02;
        ctx.beginPath();
        ctx.moveTo(mid + 0.12 * f.R * Math.cos(a), mid + 0.12 * f.R * Math.sin(a));
        ctx.lineTo(mid + (f.R + 4) * Math.cos(a), mid + (f.R + 4) * Math.sin(a));
        ctx.stroke();
      }
    }
    ctx.strokeStyle = C.muted;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(mid, mid, f.r1, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // Links between two neighbours: faint chords bent toward the centre.
    const chords: Stroke[] = [];
    for (const x of f.N1) {
      for (const y of x.adj) {
        if (x.i >= y.i || !f.N1s.has(y) || chords.length >= MAX_CHORDS) continue;
        const a = at(x);
        const b = at(y);
        chords.push({ p: [a.x, a.y, mid + (a.x + b.x - 2 * mid) * 0.2, mid + (a.y + b.y - 2 * mid) * 0.2, b.x, b.y], a: 1 });
      }
    }
    const H = hMax();
    strokeBatch(ctx, chords, C.inkSoft, 0.5, 0.11 - 0.06 * H);

    // Spokes from the centre; a spoke that is also a Relationship wears its style.
    const c = at(centre);
    const plain: Stroke[] = [];
    const hot: Stroke[] = [];
    const rels = new Set<ORel>();
    for (const x of f.N1) {
      const p = at(x);
      const typed = model.relByPair.get(pairKey(centre, x));
      if (typed?.length) {
        for (const r of typed) rels.add(r);
        continue;
      }
      plain.push({ p: [c.x, c.y, p.x, p.y], a: 1 });
      if (hs(x) > 0.01) hot.push({ p: [c.x, c.y, p.x, p.y], a: hs(x) });
    }
    strokeBatch(ctx, plain, C.ink, 0.7, 0.4 - 0.2 * H);
    strokeBatch(ctx, hot, C.candle, 1.4, 1);
    for (const r of f.relsOther) rels.add(r);
    for (const r of rels) {
      const a = at(r.s);
      const b = at(r.t);
      const touchesCentre = r.s === centre || r.t === centre;
      const rl = Math.max(hs(r.s), hs(r.t));
      const p = touchesCentre
        ? [a.x, a.y, b.x, b.y]
        : [a.x, a.y, mid + (a.x + b.x - 2 * mid) * 0.3, mid + (a.y + b.y - 2 * mid) * 0.3, b.x, b.y];
      drawRel(ctx, C, r, p, (touchesCentre ? 1 : 0.6) * (1 - 0.65 * H * (1 - rl)), b.r, 1 + 0.4 * rl);
    }

    // Nodes, smallest first so the busy ones sit on top.
    const nodes = [centre, ...f.N1].sort((a, b) => at(a).r - at(b).r);
    for (const n of nodes) {
      const p0 = at(n);
      const self = hs(n);
      let nbH = 0;
      for (const o of hp.keys()) if (o !== n && (o.adj.has(n) || n.adj.has(o))) nbH = Math.max(nbH, hs(o));
      const p = { x: p0.x, y: p0.y, r: p0.r * (1 + (HOVER_DOT_GROW - 1) * self) * (1 + (NEIGHBOUR_DOT_GROW - 1) * nbH) };
      ctx.globalAlpha = n === centre ? 1 : 1 - 0.55 * Math.max(0, H - lit(n));
      if (n.isIndex) {
        ctx.fillStyle = C.vellum;
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - p.r - 0.6);
        ctx.lineTo(p.x + p.r + 0.6, p.y);
        ctx.lineTo(p.x, p.y + p.r + 0.6);
        ctx.lineTo(p.x - p.r - 0.6, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = kindColor(C, n.kind);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.fill();
      }
      if (n === centre || self > 0.01) {
        if (self > 0.01) {
          ctx.globalAlpha = 0.2 * self;
          ctx.fillStyle = C.candle;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r + 3.5 + 4 * self, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = n === centre ? 1 : self;
        ctx.strokeStyle = C.candle;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 3.5, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    drawLabels(f);
  }

  function drawLabels(f: Focus): void {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const placed: Array<[number, number, number, number]> = [];
    const free = (x0: number, y0: number, x1: number, y1: number): boolean =>
      x0 >= 2 && x1 <= side - 2 && y0 >= 2 && y1 <= side - 2 && placed.every(([a, b, c, d]) => x1 < a || x0 > c || y1 < b || y0 > d);
    const place = (n: ONode, force: boolean, h: number, vis = 1): void => {
      const p = spots.get(n)!;
      const text = trunc(n.title, 24);
      ctx.font = `${h > 0.5 ? 700 : 500} ${LABEL_PX * (1 + 0.15 * h)}px ${fonts.sans}`;
      const w = ctx.measureText(text).width;
      const gap = p.r * (1 + (HOVER_DOT_GROW - 1) * h) + 5;
      // Prefer the outward side; fall back to the other.
      const outward = p.x < side / 2;
      for (const toLeft of [outward, !outward]) {
        let x0 = toLeft ? p.x - gap - w : p.x + gap;
        let x1 = x0 + w;
        if (force) {
          const shift = clamp(x0 - 5, 2, side - 2 - (w + 10)) + 5 - x0;
          x0 += shift;
          x1 += shift;
        }
        if (!force && !free(x0 - 3, p.y - 9, x1 + 3, p.y + 9)) continue;
        ctx.globalAlpha = 0.92 * vis;
        ctx.fillStyle = C.vellum;
        ctx.fillRect(x0 - 3, p.y - 9, w + 6, 18);
        ctx.globalAlpha = vis;
        ctx.fillStyle = C.ink;
        ctx.fillText(text, x0, p.y + 0.5);
        placed.push([x0 - 3, p.y - 9, x1 + 3, p.y + 9]);
        return;
      }
    };
    // The hovered note goes first, so it claims its space.
    const top = f.N1.slice()
      .sort((a, b) => b.degree - a.degree || a.i - b.i)
      .slice(0, LABELLED);
    // A hovered note that already had a label keeps it visible while it grows.
    for (const n of hp.keys()) if (hs(n) > 0.02) place(n, true, hs(n), Math.max(hs(n), top.includes(n) ? 1 : 0));
    for (const n of top) if (!hp.has(n)) place(n, false, 0);
  }

  function pick(mx: number, my: number): ONode | null {
    if (!F) return null;
    let best: ONode | null = null;
    let bd = Infinity;
    for (const n of [centre, ...F.N1]) {
      const p = spots.get(n)!;
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d <= Math.max(p.r + 4, 7) && d < bd) {
        best = n;
        bd = d;
      }
    }
    return best;
  }
  const local = (ev: MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  function setHover(n: ONode | null): void {
    hover = n;
    if (n && !hp.has(n)) hp.set(n, 0);
    kick();
  }
  function onMove(ev: PointerEvent): void {
    const n = pick(...local(ev));
    canvas.style.cursor = n && n !== centre ? 'pointer' : 'default';
    if (n === hover) return;
    setHover(n);
  }
  function onLeave(): void {
    if (!hover) return;
    setHover(null);
  }
  function onClick(ev: MouseEvent): void {
    const n = pick(...local(ev));
    if (n && n !== centre) hooks.onOpen(n);
  }
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);

  return {
    setPalette(p, f) {
      C = p;
      fonts = f;
      draw();
    },
    resize(s, dpr) {
      side = s;
      canvas.width = Math.round(s * dpr);
      canvas.height = Math.round(s * dpr);
      canvas.style.width = `${s}px`;
      canvas.style.height = `${s}px`;
      layout();
      draw();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
    },
  };
}
