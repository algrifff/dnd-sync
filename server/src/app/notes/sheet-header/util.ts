// Pure helpers shared by the SheetHeader tree. No React, no fetch.

export type CanonicalKind = 'character' | 'person' | 'creature' | 'item' | 'location';

/** Collapse legacy kinds into canonical ones. Mirrors the mapping in
 *  server/src/lib/ai/tools.ts so the header and the AI tools stay in
 *  lock-step. Returns null for kinds we don't render a header for. */
export function normalizeKind(raw: unknown): CanonicalKind | null {
  if (typeof raw !== 'string') return null;
  switch (raw.toLowerCase()) {
    case 'character':
    case 'pc':
    case 'ally':
      return 'character';
    case 'person':
    case 'npc':
    case 'villain':
      return 'person';
    case 'creature':
    case 'monster':
      return 'creature';
    case 'item':
      return 'item';
    case 'location':
      return 'location';
    default:
      return null;
  }
}

/** Ability modifier: floor((score - 10) / 2). */
export function abilityModifier(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.floor((score - 10) / 2);
}

export function formatModifier(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

/** "Warlock 3 / Sorcerer 2" from an array of `{ ref: { name }, level }`. */
export function formatClassList(
  classes: unknown,
): string {
  if (!Array.isArray(classes)) return '';
  const parts: string[] = [];
  for (const c of classes) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    const ref = obj.ref as Record<string, unknown> | undefined;
    const name =
      (typeof ref?.name === 'string' ? ref.name : undefined) ??
      (typeof obj.name === 'string' ? obj.name : undefined);
    const level =
      typeof obj.level === 'number' ? obj.level : undefined;
    if (!name) continue;
    parts.push(level ? `${name} ${level}` : name);
  }
  return parts.join(' / ');
}

/** Pull `ref.name` off a new-shape `{ ref: { name: '...' } }` field, falling
 *  back to the raw string if the sheet still uses legacy flat shape. */
export function refName(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const ref = obj.ref as Record<string, unknown> | undefined;
    if (typeof ref?.name === 'string' && ref.name.trim()) return ref.name.trim();
    if (typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim();
  }
  return null;
}

/** Extract a portrait URL from either the new `sheet.portrait` shape, the
 *  legacy `fm.portrait` shape, or our `asset:<id>` picker output. */
export function portraitUrl(
  portraitValue: string | null | undefined,
): string | null {
  if (!portraitValue) return null;
  if (portraitValue.startsWith('asset:')) {
    return `/api/assets/${portraitValue.slice('asset:'.length)}`;
  }
  return `/api/assets/by-path?path=${encodeURIComponent(portraitValue)}`;
}

/** Read HP from either the nested new shape or legacy flat. */
export function readHitPoints(sheet: Record<string, unknown>): {
  current: number | null;
  max: number | null;
  temporary: number | null;
} {
  const hp = sheet.hit_points;
  if (hp && typeof hp === 'object') {
    const obj = hp as Record<string, unknown>;
    return {
      current: numOrNull(obj.current),
      max: numOrNull(obj.max),
      temporary: numOrNull(obj.temporary),
    };
  }
  return {
    current: numOrNull(sheet.hp_current),
    max: numOrNull(sheet.hp_max),
    temporary: numOrNull(sheet.hp_temporary),
  };
}

export function readArmorClass(sheet: Record<string, unknown>): number | null {
  const ac = sheet.armor_class;
  if (ac && typeof ac === 'object') {
    const val = (ac as Record<string, unknown>).value;
    if (typeof val === 'number') return val;
  }
  return numOrNull(sheet.ac);
}

export function readSpeed(sheet: Record<string, unknown>): number | null {
  const sp = sheet.speed;
  if (sp && typeof sp === 'object') {
    const walk = (sp as Record<string, unknown>).walk;
    if (typeof walk === 'number') return walk;
  }
  return numOrNull(sheet.speed);
}

export function readAbilityScores(sheet: Record<string, unknown>): {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
} | null {
  const a = sheet.ability_scores;
  if (!a || typeof a !== 'object') return null;
  const obj = a as Record<string, unknown>;
  const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
  const out = {} as Record<(typeof keys)[number], number>;
  let any = false;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
      any = true;
    } else {
      out[k] = 10;
    }
  }
  return any ? out : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Initiative = DEX modifier + optional `initiative_bonus`. Returns null
 *  when no ability scores are present. */
export function readInitiative(
  sheet: Record<string, unknown>,
): number | null {
  const scores = readAbilityScores(sheet);
  if (!scores) return null;
  const dexMod = abilityModifier(scores.dex);
  const bonus = numOrNull(sheet.initiative_bonus) ?? 0;
  return dexMod + bonus;
}

/** Round-trip a "Warlock 3 / Sorcerer 2" style label back into the
 *  nested `classes: [{ ref: { name }, level }]` shape. If the string
 *  doesn't match that pattern, we still store each `/`-delimited chunk
 *  as `{ ref: { name: chunk } }` so nothing is lost. */
export function parseClassList(label: string): Array<{
  ref: { name: string };
  level?: number;
}> {
  return label
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((chunk) => {
      const m = /^(.*?)(?:\s+(\d+))?$/.exec(chunk);
      const name = (m?.[1] ?? chunk).trim();
      const levelStr = m?.[2];
      const level = levelStr ? Number(levelStr) : undefined;
      return level !== undefined
        ? { ref: { name }, level }
        : { ref: { name } };
    });
}

/** Rarity → parchment-palette colour variable name. */
export const RARITY_COLOR: Record<string, string> = {
  common: '--ink-soft',
  uncommon: '--moss',
  rare: '--sage',
  'very rare': '--wine',
  legendary: '--embers',
  artifact: '--candlelight',
};

/** Disposition → parchment-palette colour variable name. */
export const DISPOSITION_COLOR: Record<string, string> = {
  friendly: '--moss',
  neutral: '--ink-soft',
  hostile: '--wine',
  unknown: '--rule',
};

/** Pick a title font-size class for a name based on its length so a
 *  really long character / creature name doesn't overflow or force a
 *  wrap that breaks the header layout.
 *
 *  `hero` covers the big title on Character / Creature / Location;
 *  `compact` covers Person / Item which sit in narrower rows. */
export function titleSizeClass(
  name: string,
  tier: 'hero' | 'compact',
): string {
  const len = name.trim().length;
  if (tier === 'hero') {
    if (len <= 18) return 'text-4xl';
    if (len <= 28) return 'text-3xl';
    if (len <= 40) return 'text-2xl';
    return 'text-xl';
  }
  if (len <= 22) return 'text-3xl';
  if (len <= 34) return 'text-2xl';
  return 'text-xl';
}
