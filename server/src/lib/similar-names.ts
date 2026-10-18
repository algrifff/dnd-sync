// "Does this already exist?": Notes whose title or alias is close to a
// name someone is about to create. A warning aid, never a gate, so it
// favours a few good guesses over completeness. Containment (Kingsport
// vs Kingsport Docks) is deliberately not a match: on the production
// snapshot nearly all of those were a place inside a place.
// See docs/adr/0003-connections-panel-and-manual-relationships.md.

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
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
}

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}

type Closeness = { reason: SimilarReason; distance: number };

const RANK: Record<SimilarReason, number> = { same_name: 0, close_spelling: 1, similar_word: 2 };

/** How `candidate` resembles `wanted` (both from `nameTokens`), or null. */
function compare(wanted: string[], candidate: string[]): Closeness | null {
  if (wanted.length === 0 || candidate.length === 0) return null;
  const a = wanted.join(' ');
  const b = candidate.join(' ');
  if (a === b) return { reason: 'same_name', distance: 0 };

  const shorter = Math.min(a.length, b.length);
  if (shorter >= 5) {
    const distance = editDistance(a, b);
    if (distance <= (shorter >= 10 ? 2 : 1)) return { reason: 'close_spelling', distance };
  }

  // One long word spelled almost the same (Gundren / Gundran Rockseeker).
  // An identical word is not enough: that is containment.
  for (const x of wanted) {
    if (x.length < 5) continue;
    for (const y of candidate) {
      if (y.length >= 5 && x !== y && editDistance(x, y) <= 1) {
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

/** Notes `role` may see whose title or alias resembles `name`, closest
 *  first. Every kind but Sessions and drawings. */
export function findSimilarNotes(opts: {
  groupId: string;
  role: 'admin' | 'editor' | 'viewer';
  name: string;
  limit?: number;
  /** A Note that is not a duplicate of itself, e.g. the one being renamed. */
  excludePath?: string;
}): SimilarNote[] {
  const wanted = nameTokens(opts.name);
  if (wanted.length === 0) return [];
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

  const namesByPath = new Map<string, string[]>();
  for (const a of aliases) namesByPath.set(a.path, [...(namesByPath.get(a.path) ?? []), a.alias]);

  const found: Array<SimilarNote & Closeness> = [];
  for (const note of notes) {
    if (note.path === opts.excludePath) continue;
    const kind = kindOf(note.frontmatter_json);
    if (SKIPPED_KINDS.has(kind)) continue;
    let best: Closeness | undefined;
    for (const candidate of [note.title, ...(namesByPath.get(note.path) ?? [])]) {
      const c = compare(wanted, nameTokens(candidate));
      if (c && closer(c, best)) best = c;
    }
    if (best) found.push({ path: note.path, title: note.title, kind, ...best });
  }

  found.sort(
    (x, y) =>
      RANK[x.reason] - RANK[y.reason] ||
      x.distance - y.distance ||
      x.title.localeCompare(y.title) ||
      x.path.localeCompare(y.path),
  );
  return found.slice(0, opts.limit ?? 3).map(({ path, title, kind, reason }) => ({ path, title, kind, reason }));
}

function kindOf(frontmatterJson: string): string {
  try {
    const raw = (JSON.parse(frontmatterJson) as { kind?: unknown }).kind;
    return typeof raw === 'string' ? (parseKind(raw) ?? raw.toLowerCase()) : 'note';
  } catch {
    return 'note';
  }
}
