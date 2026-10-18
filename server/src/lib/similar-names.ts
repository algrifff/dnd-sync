// "Does this already exist?": Notes whose title or alias is close to a
// name someone is about to create. A warning aid, never a gate, so it
// favours a few good guesses over completeness. Containment (Kingsport
// vs Kingsport Docks) is deliberately not a match: on the production
// snapshot nearly all of those were a place inside a place.

import { parseKind } from '@compendium/shared';
import { getDb } from '@/lib/db';
import { hiddenNotesSql, visibilityFor } from '@/lib/notes';

export type SimilarReason = 'same_name' | 'close_spelling' | 'similar_word';

export type SimilarNote = {
  path: string;
  title: string;
  /** Canonical kind, or `note` for a plain Note. */
  kind: string;
  reason: SimilarReason;
};

/** Kinds that are never offered: a Session log or drawing is not what
 *  someone means by "this Person already exists". */
const SKIPPED_KINDS = new Set(['session', 'excalidraw']);

const STOP_WORDS = new Set(['the', 'a', 'an', 'of']);

/** Lowercase, accent-free words of `name`: a parenthetical, punctuation
 *  and stop words dropped. */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
}

/** Damerau-Levenshtein (optimal string alignment) distance. Keeps three
 *  rows (previous-previous, previous, current) instead of the full table. */
export function editDistance(a: string, b: string): number {
  const w = b.length + 1;
  let prev2 = new Array<number>(w).fill(0);
  let prev = Array.from({ length: w }, (_, j) => j);
  let cur = new Array<number>(w).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
    }
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[b.length]!;
}

type Closeness = { reason: SimilarReason; distance: number };

const RANK: Record<SimilarReason, number> = { same_name: 0, close_spelling: 1, similar_word: 2 };

/** The all-digit tokens of a name, in order, as one comparable string. */
function numbersOf(tokens: string[]): string {
  return tokens.filter((t) => /^\p{N}+$/u.test(t)).join(' ');
}

/** How `candidate` resembles `wanted` (both from `nameTokens`), or null. */
function compare(wanted: string[], candidate: string[]): Closeness | null {
  if (wanted.length === 0 || candidate.length === 0) return null;
  const a = wanted.join(' ');
  const b = candidate.join(' ');
  if (a === b) return { reason: 'same_name', distance: 0 };

  // Room 12 vs Room 13 is a different Note, not a misspelling.
  if (numbersOf(wanted) !== numbersOf(candidate)) return null;

  const shorter = Math.min(a.length, b.length);
  if (shorter >= 5) {
    const allowed = shorter >= 10 ? 2 : 1;
    if (Math.abs(a.length - b.length) <= allowed) {
      const distance = editDistance(a, b);
      if (distance <= allowed) return { reason: 'close_spelling', distance };
    }
  }

  // One long word spelled almost the same (Gundren / Gundran Rockseeker).
  // An identical word is not enough: that is containment.
  for (const x of wanted) {
    if (x.length < 5) continue;
    for (const y of candidate) {
      if (y.length >= 5 && x !== y && Math.abs(x.length - y.length) <= 1 && editDistance(x, y) <= 1) {
        return { reason: 'similar_word', distance: 1 };
      }
    }
  }
  return null;
}

function closer(a: Closeness, b: Closeness | undefined): boolean {
  if (!b) return true;
  return RANK[a.reason] !== RANK[b.reason] ? RANK[a.reason] < RANK[b.reason] : a.distance < b.distance;
}

type Role = 'admin' | 'editor' | 'viewer';

type IndexEntry = { path: string; title: string; kind: string; names: string[] };

/** Every Note a role may see in a World, with its title and aliases,
 *  loaded once so many names can be matched against it. */
export type NameIndex = IndexEntry[];

export function loadNameIndex(opts: { groupId: string; role: Role }): NameIndex {
  const db = getDb();
  const hidden = hiddenNotesSql('n', visibilityFor(opts.role));

  const notes = db
    .query<{ path: string; title: string; frontmatter_json: string }, [string]>(
      `SELECT n.path, n.title, n.frontmatter_json FROM notes n WHERE n.group_id = ?${hidden}`,
    )
    .all(opts.groupId);
  const aliases = db
    .query<{ path: string; alias: string }, [string]>(
      `SELECT a.path, a.alias FROM aliases a JOIN notes n
         ON n.group_id = a.group_id AND n.path = a.path
        WHERE a.group_id = ?${hidden}`,
    )
    .all(opts.groupId);

  const aliasesByPath = new Map<string, string[]>();
  for (const a of aliases) {
    const list = aliasesByPath.get(a.path);
    if (list) list.push(a.alias);
    else aliasesByPath.set(a.path, [a.alias]);
  }

  const index: NameIndex = [];
  for (const note of notes) {
    const kind = kindOf(note.frontmatter_json);
    if (SKIPPED_KINDS.has(kind)) continue;
    index.push({
      path: note.path,
      title: note.title,
      kind,
      names: [note.title, ...(aliasesByPath.get(note.path) ?? [])],
    });
  }
  return index;
}

/** Entries of `index` resembling `name`, closest first. Callers narrow
 *  the index (by kind, say) before matching. */
export function matchName(index: NameIndex, name: string, limit = 3): SimilarNote[] {
  const wanted = nameTokens(name);
  if (wanted.length === 0) return [];

  const found: Array<SimilarNote & Closeness> = [];
  for (const entry of index) {
    let best: Closeness | undefined;
    for (const candidate of entry.names) {
      const c = compare(wanted, nameTokens(candidate));
      if (c && closer(c, best)) best = c;
    }
    if (best) found.push({ path: entry.path, title: entry.title, kind: entry.kind, ...best });
  }

  found.sort(
    (x, y) =>
      RANK[x.reason] - RANK[y.reason] ||
      x.distance - y.distance ||
      x.title.localeCompare(y.title) ||
      x.path.localeCompare(y.path),
  );
  return found.slice(0, limit).map(({ path, title, kind, reason }) => ({ path, title, kind, reason }));
}

/** Notes `role` may see whose title or alias resembles `name`, closest
 *  first. Every kind but Sessions and drawings. */
export function findSimilarNotes(opts: {
  groupId: string;
  role: Role;
  name: string;
  limit?: number;
}): SimilarNote[] {
  if (nameTokens(opts.name).length === 0) return [];
  return matchName(loadNameIndex(opts), opts.name, opts.limit);
}

function kindOf(frontmatterJson: string): string {
  try {
    const raw = (JSON.parse(frontmatterJson) as { kind?: unknown }).kind;
    return typeof raw === 'string' ? (parseKind(raw) ?? raw.toLowerCase()) : 'note';
  } catch {
    return 'note';
  }
}
