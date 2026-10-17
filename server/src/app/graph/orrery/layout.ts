// Pure, deterministic layout for the Orrery graph view. No DOM, no
// randomness, no simulation: the same payload and filters always give
// the same positions, so a transition between two layouts can be a plain
// interpolation.
//
// Two layouts exist:
//   - the "world wheel": campaigns are angular sectors sized by note
//     count, kinds run outward as rings, index notes are hub diamonds and
//     Sessions sit on an optional outer arc;
//   - the "satellites" focus: one note at the centre, its direct links on
//     ring 1 and a capped set of two-step notes on ring 2, with one sector
//     per kind.
//
// Input is the /api/graph payload (types from lib/graph.ts, imported as
// types only so no server code reaches the client bundle).

import type { GraphPayload } from '@/lib/graph';
import type { NoteKind, RelationType } from '@compendium/shared';

// ───────────────────────────────────────────── constants + math

export const TAU = Math.PI * 2;
const PHI = 0.6180339887;

export const KIND_ORDER = [
  'character',
  'person',
  'creature',
  'location',
  'item',
  'quest',
  'lore',
  'note',
] as const;

/** Kinds shown as rings, plus the two that get their own treatment. */
export type RingKind = (typeof KIND_ORDER)[number];
export type FocusKind = NoteKind | 'index';

const FOCUS_KINDS: readonly FocusKind[] = [...KIND_ORDER, 'session', 'index'];

/** Campaign key for notes that sit directly at the root of the world. */
export const UNFILED = '(unfiled)';

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x));
const fract = (x: number): number => x - Math.floor(x);

/** Shortest signed angle from a to b. */
export function angDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

const byText = (a: string, b: string): number => a.localeCompare(b, 'en');

// ───────────────────────────────────────────── model

export type HubRole = 'camp' | 'band' | 'empty';

export interface ONode {
  /** Stable index into `Model.nodes`. */
  i: number;
  id: string;
  title: string;
  tags: string[];
  degree: number;
  kind: NoteKind;
  /** Campaign slug, else the top-level folder, else UNFILED. */
  campaign: string;
  isIndex: boolean;
  folder: string;
  /** Session episode number parsed from the title or path. */
  ep: number | null;
  role: HubRole | null;
  bandKind: string | null;
  adj: Set<ONode>;
  rels: ORel[];
}

export interface OLink {
  s: ONode;
  t: ONode;
  /** One end is an index note (a hub spoke). */
  index: boolean;
}

export interface ORel {
  s: ONode;
  t: ONode;
  type: RelationType;
}

export interface Model {
  nodes: ONode[];
  byId: Map<string, ONode>;
  links: OLink[];
  rels: ORel[];
  relByPair: Map<string, ORel[]>;
  /** Campaign keys, biggest first. */
  camps: string[];
}

export const pairKey = (a: ONode, b: ONode): string =>
  a.i < b.i ? `${a.i}_${b.i}` : `${b.i}_${a.i}`;

export function relNeighbours(n: ONode): ONode[] {
  return n.rels.map((r) => (r.s === n ? r.t : r.s));
}

/** Everything one hop away, by link or by Relationship. */
export function neighbours(n: ONode): Set<ONode> {
  return new Set([...n.adj, ...relNeighbours(n)]);
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Campaign slug, else the top-level folder ("World Lore"), else UNFILED. */
export function campaignKey(id: string, campaign: string | null): string {
  if (campaign) return campaign;
  const i = id.indexOf('/');
  return i < 0 ? UNFILED : id.slice(0, i);
}

/** "Episode 12" / "Session 3" in a title or path. */
export function episodeOf(title: string, id: string): number | null {
  const m = /(?:episode|session)\s*0*(\d+)/i.exec(title) ?? /(?:episode|session)\s*0*(\d+)/i.exec(id);
  return m?.[1] ? Number(m[1]) : null;
}

/** Sessions in play order: by episode number, unnumbered last, then by title. */
export function sessionOrder(list: readonly ONode[]): ONode[] {
  return list
    .slice()
    .sort((x, y) => (x.ep ?? 1e4) - (y.ep ?? 1e4) || byText(x.title, y.title));
}

const FOLDER_KIND: Record<string, string> = {
  Characters: 'character',
  People: 'person',
  Creatures: 'creature',
  Enemies: 'creature',
  Places: 'location',
  Loot: 'item',
  Items: 'item',
  Quests: 'quest',
  'Adventure Log': 'session',
  Lore: 'lore',
};

export function buildModel(payload: Pick<GraphPayload, 'nodes' | 'edges' | 'relations'>): Model {
  const nodes: ONode[] = payload.nodes.map((d, i) => ({
    i,
    id: d.id,
    title: d.title,
    tags: d.tags,
    degree: d.degree,
    kind: d.kind,
    campaign: campaignKey(d.id, d.campaign),
    isIndex: d.isIndex,
    folder: dirname(d.id),
    ep: null,
    role: null,
    bandKind: null,
    adj: new Set<ONode>(),
    rels: [],
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // /api/graph edges are directed, so two notes that link to each other
  // arrive as two edges. A link here is an unordered pair of notes: keep
  // the first direction seen and count the pair once.
  const links: OLink[] = [];
  const seen = new Set<string>();
  for (const e of payload.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s === t) continue;
    const key = pairKey(s, t);
    if (seen.has(key)) continue;
    seen.add(key);
    s.adj.add(t);
    t.adj.add(s);
    links.push({ s, t, index: s.isIndex || t.isIndex });
  }

  // Degree is the number of distinct notes linked, not directed edges.
  for (const n of nodes) n.degree = n.adj.size;

  const rels: ORel[] = [];
  const relByPair = new Map<string, ORel[]>();
  for (const r of payload.relations) {
    const s = byId.get(r.source);
    const t = byId.get(r.target);
    if (!s || !t || s === t) continue;
    const rel: ORel = { s, t, type: r.relation };
    rels.push(rel);
    s.rels.push(rel);
    t.rels.push(rel);
    const k = pairKey(s, t);
    const bucket = relByPair.get(k);
    if (bucket) bucket.push(rel);
    else relByPair.set(k, [rel]);
  }

  // Index notes become hubs: the campaign root, a kind's folder, or an
  // empty folder.
  const folderMembers = new Map<string, ONode[]>();
  for (const n of nodes) {
    if (n.isIndex) continue;
    const bucket = folderMembers.get(n.folder);
    if (bucket) bucket.push(n);
    else folderMembers.set(n.folder, [n]);
  }
  for (const n of nodes) {
    if (n.kind === 'session' && !n.isIndex) n.ep = episodeOf(n.title, n.id);
    if (!n.isIndex) continue;
    const root = n.id.startsWith('Campaigns/') ? `Campaigns/${n.campaign}` : n.campaign;
    if (n.folder === root) {
      n.role = 'camp';
      continue;
    }
    const mem = folderMembers.get(n.folder) ?? [];
    const count = new Map<string, number>();
    for (const m of mem) count.set(m.kind, (count.get(m.kind) ?? 0) + 1);
    const major = [...count.entries()].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]?.[0];
    n.bandKind = major ?? FOLDER_KIND[n.folder.split('/').pop() ?? ''] ?? 'note';
    n.role = mem.length ? 'band' : 'empty';
  }

  const size = new Map<string, number>();
  for (const n of nodes) if (!n.isIndex) size.set(n.campaign, (size.get(n.campaign) ?? 0) + 1);
  for (const n of nodes) if (!size.has(n.campaign)) size.set(n.campaign, 0);
  const camps = [...size.keys()].sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0) || byText(a, b));

  return { nodes, byId, links, rels, relByPair, camps };
}

// ───────────────────────────────────────────── filters

export interface Filters {
  kinds: ReadonlySet<string>;
  camps: ReadonlySet<string>;
  showIndex: boolean;
  showSessions: boolean;
}

export function noteVisible(n: ONode, f: Filters): boolean {
  if (!f.camps.has(n.campaign)) return false;
  if (n.isIndex) return f.showIndex;
  if (n.kind === 'session') return f.showSessions;
  return f.kinds.has(n.kind);
}

// ───────────────────────────────────────────── allocation

/** Share `avail` between weights, never giving anyone less than `min`. */
export function allocate(weights: readonly number[], avail: number, min: number): number[] {
  const spans = weights.map(() => 0);
  const fixed = new Set<number>();
  for (let pass = 0; pass < 4; pass++) {
    const free = weights.reduce((a, w, i) => (fixed.has(i) ? a : a + w), 0);
    const room = avail - fixed.size * min;
    let changed = false;
    weights.forEach((w, i) => {
      if (fixed.has(i)) return;
      spans[i] = (room * w) / (free || 1);
      if (spans[i]! < min) {
        fixed.add(i);
        changed = true;
      }
    });
    fixed.forEach((i) => {
      spans[i] = min;
    });
    if (!changed) break;
  }
  return spans;
}

// ───────────────────────────────────────────── targets

/** Where a node should be, how big, and how visible. */
export interface Target {
  x: number;
  y: number;
  r: number;
  a: number;
}

export interface Polar {
  th: number;
  rho: number;
}

// ───────────────────────────────────────────── wheel layout

export interface WheelGeom {
  R: number;
  rHub: number;
  rIn: number;
  rOut: number;
  rS0: number;
  rS1: number;
  rLab: number;
}

export function wheelGeom(R: number): WheelGeom {
  return { R, rHub: 0.115 * R, rIn: 0.185 * R, rOut: 0.79 * R, rS0: 0.85 * R, rS1: 0.895 * R, rLab: 0.955 * R };
}

export interface Band {
  kind: string;
  r0: number;
  r1: number;
  /** Angle of the band's label anchor. */
  tha: number;
  n: number;
  alpha: number;
  ax: number;
  ay: number;
}

export interface Sector {
  camp: string;
  a0: number;
  a1: number;
  span: number;
  mid: number;
  /** Hub point (campaign index sits here). */
  hx: number;
  hy: number;
  /** Session anchor on the outer arc. */
  sx: number;
  sy: number;
  bands: Band[];
  all: number;
  nSess: number;
  alpha: number;
  sessions: ONode[];
}

export interface Wheel {
  type: 'wheel';
  g: WheelGeom;
  sectors: Sector[];
  by: Map<string, Sector>;
  R: number;
  pos: Map<ONode, Polar>;
}

function finishSector(s: Sector, g: WheelGeom): Sector {
  s.a1 = s.a0 + s.span;
  s.mid = s.a0 + s.span / 2;
  s.hx = g.rHub * Math.cos(s.mid);
  s.hy = g.rHub * Math.sin(s.mid);
  const sr = g.rS0 - 0.035 * g.R;
  s.sx = sr * Math.cos(s.mid);
  s.sy = sr * Math.sin(s.mid);
  for (const b of s.bands) {
    b.ax = b.r0 * Math.cos(b.tha);
    b.ay = b.r0 * Math.sin(b.tha);
  }
  return s;
}

/** Campaign sectors by note count; `drill` rotates a campaign to the top
 *  and gives it most of the circle. */
export function computeWheel(model: Model, f: Filters, R: number, drill: string | null = null): Wheel {
  const g = wheelGeom(R);
  const camps = model.camps.filter((c) => f.camps.has(c));
  type Bucket = { kinds: Map<string, ONode[]>; sessions: ONode[]; all: number };
  const B = new Map<string, Bucket>(camps.map((c) => [c, { kinds: new Map(), sessions: [], all: 0 }]));
  for (const n of model.nodes) {
    if (n.isIndex) continue;
    const b = B.get(n.campaign);
    if (!b) continue;
    b.all++;
    if (n.kind === 'session') b.sessions.push(n);
    else if (f.kinds.has(n.kind)) {
      const list = b.kinds.get(n.kind);
      if (list) list.push(n);
      else b.kinds.set(n.kind, [n]);
    }
  }
  const pos = new Map<ONode, Polar>();
  let order = camps.slice();
  if (order.length === 0) return { type: 'wheel', g, sectors: [], by: new Map(), R, pos };
  if (drill && B.has(drill)) {
    const i = order.indexOf(drill);
    order = [...order.slice(i), ...order.slice(0, i)];
  }
  const weights = order.map((c) => {
    const b = B.get(c)!;
    let w = 0;
    b.kinds.forEach((v) => {
      w += v.length;
    });
    if (f.showSessions) w += b.sessions.length;
    return Math.max(w, 1);
  });
  if (drill && B.has(drill) && order.length > 1) {
    const others = weights.slice(1).reduce((a, b) => a + b, 0);
    weights[0] = others * (0.64 / 0.36);
  }
  const gap = order.length > 1 ? 0.024 : 0;
  const spans = allocate(weights, TAU - gap * order.length, 0.075);
  const sectors: Sector[] = [];
  let a = -Math.PI / 2 - spans[0]! / 2;
  order.forEach((c, ci) => {
    const b = B.get(c)!;
    const span = spans[ci]!;
    const s: Sector = {
      camp: c, a0: a + gap / 2, a1: 0, span, mid: 0, hx: 0, hy: 0, sx: 0, sy: 0,
      bands: [], all: b.all, nSess: b.sessions.length, alpha: 1, sessions: [],
    };
    a += span + gap;
    const K = KIND_ORDER.filter((k) => b.kinds.has(k));
    const totalK = K.reduce((t, k) => t + b.kinds.get(k)!.length, 0);
    const extra = Math.max(3, 0.05 * totalK);
    const denom = totalK + extra * K.length;
    let r2 = g.rIn * g.rIn;
    const area = g.rOut * g.rOut - g.rIn * g.rIn;
    const pad = Math.min(s.span * 0.06, 0.014);
    K.forEach((k, j) => {
      const list = b.kinds.get(k)!.slice().sort((x, y) => byText(x.title, y.title) || byText(x.id, y.id));
      const r0 = Math.sqrt(r2);
      r2 += (area * (list.length + extra)) / denom;
      const r1 = Math.sqrt(r2);
      s.bands.push({
        kind: k, r0, r1, tha: s.a0 + (s.span * (j + 0.5)) / K.length, n: list.length, alpha: 1, ax: 0, ay: 0,
      });
      const q0 = (r0 + 3) ** 2;
      const q1 = Math.max(r0 + 3.5, r1 - 3) ** 2;
      const n = list.length;
      list.forEach((nd, i) => {
        const u = (i + 0.5) / n;
        const v = fract(0.5 + i * PHI);
        pos.set(nd, { th: s.a0 + pad + u * (s.span - 2 * pad), rho: Math.sqrt(q0 + v * (q1 - q0)) });
      });
    });
    const ses = sessionOrder(b.sessions);
    const arc = ((g.rS0 + g.rS1) / 2) * (s.span - 2 * pad);
    const tight = arc / Math.max(1, ses.length) < 10;
    ses.forEach((nd, i) => {
      pos.set(nd, {
        th: s.a0 + pad + ((i + 0.5) / ses.length) * (s.span - 2 * pad),
        rho: tight ? (i % 2 ? g.rS1 : g.rS0) : (g.rS0 + g.rS1) / 2,
      });
    });
    s.sessions = ses;
    sectors.push(finishSector(s, g));
  });
  const by = new Map(sectors.map((s) => [s.camp, s]));

  // Index hubs.
  const dup = new Map<string, Array<[ONode, Band]>>();
  const empties = new Map<string, ONode[]>();
  for (const n of model.nodes) {
    if (!n.isIndex) continue;
    const s = by.get(n.campaign);
    if (!s) continue;
    if (n.role === 'camp') {
      pos.set(n, { th: s.mid, rho: g.rHub });
      continue;
    }
    const band = n.role === 'band' ? s.bands.find((q) => q.kind === n.bandKind) : undefined;
    if (n.role === 'band' && n.bandKind === 'session') {
      pos.set(n, { th: s.mid, rho: g.rS0 - 0.035 * g.R });
      continue;
    }
    if (band) {
      const key = `${s.camp}|${band.kind}`;
      const list = dup.get(key);
      if (list) list.push([n, band]);
      else dup.set(key, [[n, band]]);
      continue;
    }
    const list = empties.get(s.camp);
    if (list) list.push(n);
    else empties.set(s.camp, [n]);
  }
  dup.forEach((list) =>
    list.forEach(([n, band], j) => {
      pos.set(n, { th: band.tha + (j - (list.length - 1) / 2) * (9 / band.r0), rho: band.r0 });
    }),
  );
  empties.forEach((list, c) => {
    const s = by.get(c)!;
    list.forEach((n, j) => {
      const rho = g.rHub + 10;
      pos.set(n, { th: s.mid + (j - (list.length - 1) / 2) * (6 / rho), rho });
    });
  });
  return { type: 'wheel', g, sectors, by, R, pos };
}

/** Blend two wheels so sectors and bands slide rather than jump. */
export function lerpWheel(A: Wheel, B: Wheel, e: number, camps: readonly string[]): Wheel {
  const g = {} as WheelGeom;
  for (const k of Object.keys(B.g) as Array<keyof WheelGeom>) g[k] = lerp(A.g[k], B.g[k], e);
  const sectors: Sector[] = [];
  for (const c of camps) {
    const a = A.by.get(c);
    const b = B.by.get(c);
    if (!a && !b) continue;
    if (a && b) {
      const s: Sector = {
        ...b,
        a0: a.a0 + angDelta(a.a0, b.a0) * e,
        span: lerp(a.span, b.span, e),
        alpha: 1,
        bands: [],
      };
      for (const k of [...KIND_ORDER] as string[]) {
        const x = a.bands.find((q) => q.kind === k);
        const y = b.bands.find((q) => q.kind === k);
        if (x && y) {
          s.bands.push({
            ...y, r0: lerp(x.r0, y.r0, e), r1: lerp(x.r1, y.r1, e), tha: x.tha + angDelta(x.tha, y.tha) * e, alpha: 1,
          });
        } else if (x || y) {
          s.bands.push({ ...(x ?? y)!, alpha: x ? 1 - e : e });
        }
      }
      sectors.push(finishSector(s, g));
    } else {
      sectors.push({ ...(a ?? b)!, alpha: a ? 1 - e : e });
    }
  }
  return { type: 'wheel', g, sectors, by: new Map(sectors.map((s) => [s.camp, s])), R: B.R, pos: B.pos };
}

/** Hub marker radii on the wheel: campaign discs (2x the old 4.6) and kind-hub diamonds (1.4x the old 3.3). */
export const HUB_R = { camp: 9.2, band: 4.6, empty: 1.6 } as const;

export const wheelRadius = (n: ONode): number => 1.3 + Math.sqrt(n.degree) * 0.62;

/** Hub index notes that appear on the wheel for the current filters. */
function hubVisible(n: ONode, W: Wheel, f: Filters): boolean {
  if (!W.pos.has(n)) return false;
  if (n.role === 'camp') return true;
  if (n.role === 'band') {
    if (n.bandKind === 'session') return f.showSessions;
    const s = W.by.get(n.campaign);
    // A band hub whose ring was filtered out falls back to the "empty" rule.
    return s?.bands.some((b) => b.kind === n.bandKind) ? true : f.showIndex;
  }
  return f.showIndex;
}

/** Position, size and opacity of every node on the wheel. Nodes that are
 *  not visible get `a: 0`. */
export function wheelTargets(model: Model, W: Wheel, f: Filters): Map<ONode, Target> {
  const out = new Map<ONode, Target>();
  for (const n of model.nodes) {
    const p = W.pos.get(n);
    const xy = p ? { x: p.rho * Math.cos(p.th), y: p.rho * Math.sin(p.th) } : { x: 0, y: 0 };
    if (n.isIndex) {
      out.set(n, {
        ...xy,
        r: n.role === 'camp' ? HUB_R.camp : n.role === 'empty' ? HUB_R.empty : HUB_R.band,
        a: hubVisible(n, W, f) ? 1 : 0,
      });
    } else {
      out.set(n, { ...xy, r: wheelRadius(n), a: p && noteVisible(n, f) ? 1 : 0 });
    }
  }
  return out;
}

// ───────────────────────────────────────────── link grouping

/** Notes bundle by campaign and kind; all Sessions of a campaign share one. */
export const groupKey = (n: ONode): string => `${n.campaign}|${n.kind === 'session' ? 'session' : n.kind}`;

export interface AggLink {
  a: ONode;
  b: ONode;
  /** Number of links folded into this bundle. */
  n: number;
  /** Strongest alpha among them. */
  m: number;
}

/** Fold links into one bundle per pair of groups. Links inside a single
 *  group vanish; `alphaOf` lets the caller fade bundles during a
 *  transition (a bundle with no visible end is dropped). */
export function aggregateLinks(links: Iterable<OLink>, alphaOf: (l: OLink) => number): AggLink[] {
  const agg = new Map<string, AggLink>();
  for (const l of links) {
    const m = alphaOf(l);
    if (m < 0.02) continue;
    const ka = groupKey(l.s);
    const kb = groupKey(l.t);
    if (ka === kb) continue;
    const key = ka < kb ? `${ka}>${kb}` : `${kb}>${ka}`;
    let e = agg.get(key);
    if (!e) {
      e = { a: ka < kb ? l.s : l.t, b: ka < kb ? l.t : l.s, n: 0, m: 0 };
      agg.set(key, e);
    }
    e.n++;
    e.m = Math.max(e.m, m);
  }
  return [...agg.values()];
}

/** Where a bundle attaches: the kind's band anchor, the Session anchor,
 *  or the sector hub. */
export function groupAnchor(W: Wheel, n: ONode): [number, number] | null {
  const s = W.by.get(n.campaign);
  if (!s) return null;
  if (n.kind === 'session') return [s.sx, s.sy];
  const b = s.bands.find((q) => q.kind === n.kind);
  return b ? [b.ax, b.ay] : [s.hx, s.hy];
}

/** Control points (world coordinates) of a link bent through its sector
 *  hub, or through the centre between two sectors. 6 or 8 numbers. */
export function routeWheel(W: Wheel, a: ONode, b: ONode, pa: readonly [number, number], pb: readonly [number, number]): number[] {
  const sa = W.by.get(a.campaign);
  const sb = W.by.get(b.campaign);
  if (!sa || !sb) return [pa[0], pa[1], pb[0], pb[1]];
  if (sa === sb) {
    const mx = (pa[0] + pb[0]) / 2;
    const my = (pa[1] + pb[1]) / 2;
    const beta = 0.85 * clamp(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) / (0.45 * W.R), 0.25, 1);
    return [pa[0], pa[1], lerp(mx, sa.hx, beta), lerp(my, sa.hy, beta), pb[0], pb[1]];
  }
  return [pa[0], pa[1], sa.hx * 0.3, sa.hy * 0.3, sb.hx * 0.3, sb.hy * 0.3, pb[0], pb[1]];
}

// ───────────────────────────────────────────── satellites focus layout

export interface FocusSector {
  kind: FocusKind;
  a0: number;
  span: number;
  n1: number;
  n2: number;
  over: number;
}

export interface FocusPlace extends Polar {
  ring: 1 | 2;
}

export interface Focus {
  type: 'focus';
  c: ONode;
  N1: ONode[];
  N2: ONode[];
  N1s: Set<ONode>;
  N2s: Set<ONode>;
  pos: Map<ONode, FocusPlace>;
  sectors: FocusSector[];
  r1: number;
  rA: number;
  rB: number;
  rLab: number;
  /** Ring-1 to ring-2 links. */
  e12: Array<[ONode, ONode]>;
  /** Relationships between two shown notes, neither being the centre. */
  relsOther: ORel[];
  /** Linked notes kept off the rings by the current filters. */
  hidden: { index: number; session: number; filtered: number };
  /** Two-step notes beyond the ring-2 cap. */
  overflow: number;
  R: number;
}

/** Ring 2 shows at most this many notes (fewer when ring 1 is crowded). */
export function ring2Cap(ring1Size: number): number {
  return ring1Size > 60 ? 36 : 64;
}

const focusKindOf = (n: ONode): FocusKind => (n.isIndex ? 'index' : n.kind);

export interface FocusOptions {
  /** Ring 1 only, pushed out to fill the disc: the sidebar's small view. */
  compact?: boolean;
}

export function computeFocus(model: Model, f: Filters, c: ONode, R: number, opts: FocusOptions = {}): Focus {
  const compact = opts.compact === true;
  const ok = (n: ONode): boolean => n !== c && noteVisible(n, f);
  const hidden = { index: 0, session: 0, filtered: 0 };
  const N1: ONode[] = [];
  for (const x of neighbours(c)) {
    if (x === c) continue;
    if (ok(x)) N1.push(x);
    else if (x.isIndex) hidden.index++;
    else if (x.kind === 'session') hidden.session++;
    else hidden.filtered++;
  }
  N1.sort((a, b) => a.i - b.i);
  const N1s = new Set(N1);
  const score = new Map<ONode, number>();
  for (const x of N1) {
    for (const y of neighbours(x)) {
      if (compact || y === c || N1s.has(y) || !ok(y)) continue;
      score.set(y, (score.get(y) ?? 0) + 1);
    }
  }
  const cand = [...score.keys()].sort(
    (a, b) => score.get(b)! - score.get(a)! || b.degree - a.degree || byText(a.title, b.title) || a.i - b.i,
  );
  const cap = compact ? 0 : ring2Cap(N1.length);
  const N2 = cand.slice(0, cap);
  const N2s = new Set(N2);
  const overflow = cand.slice(cap);

  const groups = FOCUS_KINDS.map((k) => ({
    kind: k,
    n1: N1.filter((n) => focusKindOf(n) === k),
    n2: N2.filter((n) => focusKindOf(n) === k),
    over: overflow.filter((n) => focusKindOf(n) === k).length,
  })).filter((q) => q.n1.length || q.n2.length);
  const gap = groups.length > 1 ? 0.04 : 0;
  const spans = allocate(
    groups.map((q) => q.n1.length + 0.35 * q.n2.length + 0.8),
    TAU - gap * groups.length,
    Math.min(0.32, (TAU - gap * groups.length) / Math.max(1, groups.length)),
  );
  const r1 = (compact ? (N1.length > 26 ? 0.5 : 0.68) : 0.32) * R;
  // A busy note would pack ring 1 solid, so the small view spreads it over
  // a few concentric tracks, alternating along each sector.
  const tracks = compact ? Math.min(5, Math.max(1, Math.ceil(N1.length / 26))) : 1;
  const trackStep = tracks > 1 ? (0.93 * R - r1) / (tracks - 1) : 0;
  const rA = 0.69 * R;
  const rB = 0.845 * R;
  const rLab = 0.925 * R;
  const pos = new Map<ONode, FocusPlace>();
  let a = -Math.PI / 2 - (groups.length > 1 ? spans[0]! / 2 : 0);
  const stagger = N1.length > 44;
  const sectors: FocusSector[] = groups.map((q, gi) => {
    const s: FocusSector = { kind: q.kind, a0: a + gap / 2, span: spans[gi]!, n1: q.n1.length, n2: q.n2.length, over: q.over };
    a += spans[gi]! + gap;
    const ord = q.n1
      .slice()
      .sort(
        (x, y) =>
          Number(model.relByPair.has(pairKey(c, y))) - Number(model.relByPair.has(pairKey(c, x))) ||
          byText(x.title, y.title) ||
          x.i - y.i,
      );
    ord.forEach((n, i) =>
      pos.set(n, { th: s.a0 + (s.span * (i + 0.5)) / ord.length, rho: r1 + (compact ? (i % tracks) * trackStep : stagger && i % 2 ? 18 : 0), ring: 1 }),
    );
    const pad = Math.min(0.02, s.span * 0.08);
    const q0 = rA * rA;
    const q1 = rB * rB;
    const two = q.n2.slice().sort((x, y) => byText(x.title, y.title) || x.i - y.i);
    two.forEach((n, i) => {
      const u = (i + 0.5) / two.length;
      const v = fract(0.5 + i * PHI);
      pos.set(n, { th: s.a0 + pad + u * (s.span - 2 * pad), rho: Math.sqrt(q0 + v * (q1 - q0)), ring: 2 });
    });
    return s;
  });
  const e12: Array<[ONode, ONode]> = [];
  for (const x of N1) for (const y of x.adj) if (N2s.has(y)) e12.push([x, y]);
  const shown = new Set<ONode>([c, ...N1, ...N2]);
  const relsOther = model.rels.filter((r) => r.s !== c && r.t !== c && shown.has(r.s) && shown.has(r.t));
  return { type: 'focus', c, N1, N2, N1s, N2s, pos, sectors, r1, rA, rB, rLab, e12, relsOther, hidden, overflow: overflow.length, R };
}

/** Targets for the nodes the focus layout places. Anything missing from
 *  the map is not on a ring and should fade out where it stands. */
export function focusTargets(F: Focus): Map<ONode, Target> {
  const out = new Map<ONode, Target>();
  out.set(F.c, { x: 0, y: 0, r: 6 + Math.sqrt(F.c.degree) * 0.85, a: 1 });
  F.pos.forEach((p, n) => {
    out.set(n, {
      x: p.rho * Math.cos(p.th),
      y: p.rho * Math.sin(p.th),
      r: p.ring === 1 ? 2.3 + Math.sqrt(n.degree) * 0.8 : 1.5 + Math.sqrt(n.degree) * 0.45,
      a: p.ring === 1 ? 1 : 0.75,
    });
  });
  return out;
}

// ───────────────────────────────────────────── search

/** Title and path search for the jump box. Empty query lists the busiest notes. */
export function searchNotes(model: Model, query: string, limit = 12): ONode[] {
  const s = query.trim().toLowerCase();
  const scored: Array<[number, ONode]> = [];
  for (const n of model.nodes) {
    const t = n.title.toLowerCase();
    let sc = -1;
    if (!s) sc = n.isIndex ? -1 : n.degree / 1000;
    else if (t.startsWith(s)) sc = 3;
    else if (t.includes(` ${s}`)) sc = 2;
    else if (t.includes(s)) sc = 1;
    else if (n.id.toLowerCase().includes(s)) sc = 0.5;
    if (sc >= 0) scored.push([sc + n.degree / 10000, n]);
  }
  return scored
    .sort((a, b) => b[0] - a[0] || a[1].i - b[1].i)
    .slice(0, limit)
    .map((x) => x[1]);
}

/** Campaign display name: the campaigns table when it knows the slug,
 *  otherwise the slug title-cased. */
export function campaignLabel(key: string, names: Readonly<Record<string, string>>): string {
  if (key === UNFILED) return 'Unfiled';
  const known = Object.hasOwn(names, key) ? names[key] : undefined;
  if (known) return known;
  return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}
