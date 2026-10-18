// The worlds rail's client-side model: one row per world from
// GET /api/worlds, joined with what this browser remembers (when each
// world was last seen, the last page visited in it). Everything here is
// pure except the small localStorage wrappers at the bottom, so the
// rules for badges, reordering, shortcuts and remembered pages are
// testable without a DOM.

export type WorldRow = {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  /** 0 = no uploaded icon. Non-zero busts the icon cache. */
  iconVersion: number;
  /** Newest visible note or asset change by another member, server
   *  epoch ms. The caller's own writes are never counted. */
  latestActivityAt: number | null;
  openSession: { path: string } | null;
};

/** World id → the world's `latestActivityAt` as last observed while the
 *  user had it open. Server time only, so the client clock never enters
 *  the comparison. */
export type SeenMap = Readonly<Record<string, number>>;

export type RailWorld = {
  row: WorldRow;
  active: boolean;
  pending: boolean;
  /** Changed since the user last had it open. Never true when active. */
  unread: boolean;
  live: boolean;
  /** 1..9 for the first nine worlds, else null. */
  shortcut: number | null;
  label: string;
  title: string;
};

export function railWorlds(
  rows: readonly WorldRow[],
  seen: SeenMap,
  activeId: string | null,
  pendingId: string | null,
): RailWorld[] {
  return rows.map((row, i) => {
    const active = row.id === activeId;
    const lastSeen = seen[row.id];
    const unread =
      !active &&
      row.latestActivityAt !== null &&
      lastSeen !== undefined &&
      row.latestActivityAt > lastSeen;
    const live = row.openSession !== null;
    const shortcut = i < 9 ? i + 1 : null;
    const states = [unread && 'new activity', live && 'session open'].filter(
      (s): s is string => typeof s === 'string',
    );
    return {
      row,
      active,
      pending: row.id === pendingId,
      unread,
      live,
      shortcut,
      label: [row.name, ...states].join(', '),
      title: [
        `${row.name} · ${row.role}`,
        ...states.map(capitalise),
        ...(shortcut ? [shortcutLabel(shortcut)] : []),
      ].join(' · '),
    };
  });
}

/** Brings the seen map up to date after a fetch. The active world (the
 *  one the server confirms, never an optimistic switch target) takes its
 *  current `latestActivityAt`. A world with no entry yet takes it too, so
 *  a first visit (or a newly joined world) never lights up every badge.
 *  Returns `seen` itself when nothing changes. */
export function reconcileSeen(
  seen: SeenMap,
  rows: readonly WorldRow[],
  activeId: string | null,
): SeenMap {
  let next: Record<string, number> | null = null;
  for (const row of rows) {
    const prev = seen[row.id];
    if (prev !== undefined && row.id !== activeId) continue;
    const at = row.latestActivityAt ?? 0;
    if (at === prev) continue;
    next ??= { ...seen };
    next[row.id] = at;
  }
  return next ?? seen;
}

export function moveTo(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, toIndex));
  rest.splice(at, 0, id);
  return rest;
}

export function moveBy(ids: readonly string[], id: string, delta: number): string[] {
  return moveTo(ids, id, ids.indexOf(id) + delta);
}

/** Orders freshly fetched rows by a local order the server may not have
 *  caught up with yet. Rows the order does not mention keep their
 *  server order after the ones it does. */
export function applyOrder<T extends { id: string }>(
  rows: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return rows
    .map((row, i) => ({ row, key: rank.get(row.id) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.row);
}

/** The rail order for a fetched list. A local order the server has not
 *  confirmed yet wins. Otherwise a stale response (one whose request
 *  started before the last order save landed) keeps the order on screen
 *  and only refreshes the rows' data. */
export function orderFetched<T extends { id: string }>(
  fetched: readonly T[],
  shown: readonly T[] | null,
  localOrder: readonly string[] | null,
  stale: boolean,
): T[] {
  if (localOrder) return applyOrder(fetched, localOrder);
  if (stale && shown) return applyOrder(fetched, shown.map((r) => r.id));
  return [...fetched];
}

/** Index of the slot whose centre is closest to `y`. */
export function nearestSlot(centres: readonly number[], y: number): number {
  let best = 0;
  for (let i = 1; i < centres.length; i++) {
    if (Math.abs(centres[i]! - y) < Math.abs(centres[best]! - y)) best = i;
  }
  return best;
}

export type RailShortcut = { kind: 'home' } | { kind: 'world'; index: number };

/** Alt+0 goes Home and Alt+1..9 to the nth world. Ctrl/Cmd+digit is the
 *  browser's own tab switcher, so the rail leaves it alone. Reads
 *  `code`, not `key`, because macOS Option+digit types a symbol. */
export function railShortcut(e: {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): RailShortcut | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const m = /^Digit([0-9])$/.exec(e.code);
  if (!m) return null;
  const n = Number(m[1]);
  return n === 0 ? { kind: 'home' } : { kind: 'world', index: n - 1 };
}

export function shortcutLabel(n: number): string {
  return `Alt+${n}`;
}

// Pages that belong to the current world. Anything else (/me,
// /settings, /admin, auth pages) is not worth returning to on a switch.
const WORLD_PAGE_PREFIXES = [
  '/home',
  '/notes',
  '/tags',
  '/graph',
  '/graph-3d',
  '/assets',
  '/excalidraw',
] as const;

/** The page to remember for the current world, or null when the page is
 *  not inside a world. Also guards values read back from storage. */
export function rememberablePath(pathname: string, search: string): string | null {
  const inWorld = WORLD_PAGE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );
  if (!inWorld) return null;
  const query = search.replace(/^\?/, '');
  return query ? `${pathname}?${query}` : pathname;
}

export function parseSeenMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function parseLastPages(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') continue;
    const q = v.indexOf('?');
    const safe =
      q < 0 ? rememberablePath(v, '') : rememberablePath(v.slice(0, q), v.slice(q + 1));
    if (safe) out[k] = safe;
  }
  return out;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// v1 held client clock times, which v2's server-time values cannot be
// compared against.
const SEEN_KEY = 'compendium.worldSeen.v2';
const LAST_PAGE_KEY = 'compendium.worldLastPage.v1';

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode: the rail just forgets */
  }
}

export function readSeen(): SeenMap {
  return parseSeenMap(readJson(SEEN_KEY));
}

export function writeSeen(seen: SeenMap): void {
  writeJson(SEEN_KEY, seen);
}

export function readLastPage(worldId: string): string | null {
  return parseLastPages(readJson(LAST_PAGE_KEY))[worldId] ?? null;
}

export function writeLastPage(worldId: string, path: string): void {
  const pages = parseLastPages(readJson(LAST_PAGE_KEY));
  if (pages[worldId] === path) return;
  writeJson(LAST_PAGE_KEY, { ...pages, [worldId]: path });
}
