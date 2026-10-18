// Colours and type for the Orrery canvas. A canvas cannot read CSS
// `var()`, so the app's palette tokens are resolved to concrete colours
// by the browser and handed to the renderer; the caller re-resolves when
// the theme flips (see OrreryCanvas), which is what makes night mode work.

import { RELATIONS, type NoteKind, type RelationGroup, type RelationType } from '@compendium/shared';
import type { FocusKind, RingKind } from './layout';

export interface Palette {
  parchment: string;
  vellum: string;
  ink: string;
  inkSoft: string;
  muted: string;
  rule: string;
  ruleDark: string;
  candle: string;
  /** Candlelight darkened enough to read as small text. */
  candleText: string;
  moss: string;
  wine: string;
  sage: string;
  embers: string;
  wisteria: string;
  deepWater: string;
  grey: string;
}

const TOKENS: Array<[keyof Palette, string]> = [
  ['parchment', '--parchment'],
  ['vellum', '--vellum'],
  ['ink', '--ink'],
  ['inkSoft', '--ink-soft'],
  ['muted', '--ink-muted'],
  ['rule', '--rule'],
  ['candle', '--candlelight'],
  ['moss', '--moss'],
  ['wine', '--wine'],
  ['sage', '--sage'],
  ['embers', '--embers'],
  ['wisteria', '--wisteria'],
  ['deepWater', '--deep-water'],
];

type Rgb = [number, number, number];

function parseRgb(css: string): Rgb | null {
  const nums = css.match(/[\d.]+/g);
  if (!nums || nums.length < 3 || !css.startsWith('rgb')) return null;
  return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
}

const rgb = (c: Rgb): string => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Resolve every palette token against `host` (so a `[data-theme]`
 *  ancestor is honoured). The browser normalises `var(--x)` to `rgb()`
 *  through a probe element's computed colour. */
export function resolvePalette(host: HTMLElement): Palette {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.appendChild(probe);
  const out = {} as Record<keyof Palette, string>;
  const parsed = {} as Record<keyof Palette, Rgb>;
  for (const [key, token] of TOKENS) {
    probe.style.color = `var(${token})`;
    const css = getComputedStyle(probe).color;
    const c = parseRgb(css) ?? ([128, 128, 128] as Rgb);
    parsed[key] = c;
    out[key] = rgb(c);
  }
  host.removeChild(probe);
  out.ruleDark = rgb(mix(parsed.rule, parsed.muted, 0.45));
  out.grey = rgb(mix(parsed.muted, parsed.parchment, 0.3));
  out.candleText = rgb(mix(parsed.candle, parsed.ink, 0.25));
  return out;
}

/** The two font stacks the canvas draws with. */
export interface Fonts {
  serif: string;
  sans: string;
}

export function resolveFonts(host: HTMLElement): Fonts {
  const cs = getComputedStyle(host);
  const fraunces = cs.getPropertyValue('--font-fraunces').trim();
  const inter = cs.getPropertyValue('--font-inter').trim();
  return {
    serif: `${fraunces ? `${fraunces}, ` : ''}"Iowan Old Style", "Palatino Linotype", Georgia, serif`,
    sans: `${inter ? `${inter}, ` : ''}"Helvetica Neue", "Segoe UI", Arial, sans-serif`,
  };
}

// ───────────────────────────────────────────── kinds

export const KIND_LABEL: Record<FocusKind, string> = {
  character: 'Characters',
  person: 'People',
  creature: 'Creatures',
  location: 'Places',
  item: 'Items',
  quest: 'Quests',
  lore: 'Lore',
  session: 'Sessions',
  note: 'Notes',
  index: 'Index notes',
};

/** Singular, for a card heading ("Character", not "Characters"). */
export function kindSingular(kind: FocusKind): string {
  return KIND_LABEL[kind].replace(/s$/, '');
}

export function kindColor(p: Palette, kind: NoteKind | 'index'): string {
  switch (kind) {
    case 'character': return p.candle;
    case 'person': return p.sage;
    case 'creature': return p.wine;
    case 'location': return p.moss;
    case 'item': return p.embers;
    case 'quest': return p.inkSoft;
    case 'lore': return p.muted;
    case 'session': return p.ruleDark;
    case 'index': return p.ink;
    default: return p.grey;
  }
}

/** Kind name colour for small text: candlelight is too pale on parchment. */
export function kindTextColor(p: Palette, kind: NoteKind | 'index'): string {
  return kind === 'character' ? p.candleText : kindColor(p, kind);
}

export type { RingKind };

// ───────────────────────────────────────────── relationships

/** A Relationship's colour comes from its group (RELATIONS in
 *  @compendium/shared). Family uses `candleText`, not `candle`: plain
 *  candlelight is about 1.9:1 against day parchment, too faint for a 1px
 *  line, and it is also the colour of a hovered note's own links. */
export const GROUP_COLOR: Record<RelationGroup, keyof Palette> = {
  friendly: 'moss',
  hostile: 'wine',
  organisation: 'wisteria',
  place: 'deepWater',
  family: 'candleText',
  neutral: 'muted',
};

export const relColor = (p: Palette, type: RelationType): string => p[GROUP_COLOR[RELATIONS[type].group]];

/** Dash, width and end marker of each type; the colour is its group's. */
export interface RelStyle {
  dash: number[];
  w: number;
  /** Draws an arrow head at the target end. */
  dir?: boolean;
  /** Draws a diamond instead of an arrow head. */
  diamond?: boolean;
}

export const REL_STYLE: Record<RelationType, RelStyle> = {
  ally_of: { dash: [], w: 1.5 },
  enemy_of: { dash: [6, 3], w: 1.5 },
  member_of: { dash: [1.5, 2.5], w: 1.6, dir: true },
  located_in: { dash: [1.5, 2.5], w: 1.6, dir: true },
  leads: { dash: [8, 3, 2, 3], w: 1.2, dir: true },
  works_for: { dash: [8, 3, 2, 3], w: 1.2, dir: true },
  owns: { dash: [], w: 1.3, dir: true, diamond: true },
  parent_of: { dash: [], w: 1, dir: true },
  related_to: { dash: [3, 4], w: 1.1 },
};

/** "ally of" read from the source note's side, "has member" from the other. */
export function relLabel(type: RelationType, fromSource: boolean): string {
  const r = RELATIONS[type];
  return fromSource ? r.label : r.inverseLabel;
}

export const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
