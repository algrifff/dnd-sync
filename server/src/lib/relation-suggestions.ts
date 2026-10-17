// Candidate Relationships read from the frontmatter `faction` and
// `location` fields of Person and Creature Notes. The pure part of
// server/scripts/suggest-relations.ts: it only SELECTs, never writes, and
// never calls addRelation. A candidate becomes a Relationship only when a
// Wrap-up proposes it and a Player reviews it (docs/adr/0002).
//
// Operator tool: it reads every Note, hidden or not, and marks a candidate
// when either end is gm_only or dm_only so the reviewer knows.

import { canonicalPair, parseKind, type NoteKind, type RelationType } from '@compendium/shared';

/** The slice of the app's Database (and bun:sqlite's) that this module needs. */
export type ReadDb = {
  query<Row>(sql: string): { all(...params: string[]): Row[] };
};

const SOURCE_KINDS: readonly NoteKind[] = ['person', 'creature'];

/** Which frontmatter field proposes which Relationship. */
export const FIELD_RELATIONS = {
  faction: 'member_of',
  location: 'located_in',
} as const satisfies Record<string, RelationType>;
export type SuggestField = keyof typeof FIELD_RELATIONS;
const FIELDS = Object.keys(FIELD_RELATIONS) as SuggestField[];

export type NoteRef = { path: string; title: string };
export type Hidden = 'gm_only' | 'dm_only';

export type Candidate = {
  from: NoteRef;
  relation: RelationType;
  to: NoteRef;
  field: SuggestField;
  /** `lower` when only the text before a trailing parenthetical matched. */
  confidence: 'high' | 'lower';
  /** The raw frontmatter value this came from. */
  value: string;
  hidden: Hidden[];
};

export type Ambiguous = {
  from: NoteRef;
  relation: RelationType;
  field: SuggestField;
  value: string;
  matches: NoteRef[];
};

export type UnresolvedValue = { field: SuggestField; value: string; count: number };

export type WorldSuggestions = {
  groupId: string;
  groupName: string;
  candidates: Candidate[];
  ambiguous: Ambiguous[];
  /** Ranked by how many Notes use the value. */
  unresolved: UnresolvedValue[];
  counts: {
    candidates: number;
    ambiguous: number;
    unresolved: number;
    placeholders: number;
    alreadyRecorded: number;
    selfReferences: number;
  };
};

const PLACEHOLDER = /^(?:[-–—]*|n\/a|none|unknown|(?:unknown|none)\s*\(.*)$/i;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

/** `[[Target|alias]]` and `[[Target#Heading]]` become `Target`; anything
 *  else is only trimmed. */
export function stripWikilink(value: string): string {
  const m = /^\[\[([^\]]*)\]\]$/.exec(value.trim());
  if (!m) return value.trim();
  return m[1]!.split('|')[0]!.split('#')[0]!.trim();
}

/** A frontmatter value as a list of strings: a string, an array of
 *  strings, or nothing. Other types are ignored. */
export function fieldValues(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : [raw];
  return items.filter((v): v is string => typeof v === 'string');
}

const fold = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

type Note = NoteRef & { dmOnly: boolean; gmOnly: boolean; kind: NoteKind | null; fm: Record<string, unknown> };

type Index = { titles: Map<string, Note[]>; aliases: Map<string, Note[]> };

function addTo(map: Map<string, Note[]>, key: string, note: Note): void {
  if (!key) return;
  const list = map.get(key);
  if (!list) map.set(key, [note]);
  else if (!list.includes(note)) list.push(note);
}

function buildIndex(notes: Note[], aliasRows: { alias: string; path: string }[]): Index {
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const index: Index = { titles: new Map(), aliases: new Map() };
  for (const n of notes) {
    addTo(index.titles, fold(n.title), n);
    for (const a of fieldValues(n.fm.aliases)) addTo(index.aliases, fold(a), n);
  }
  for (const row of aliasRows) {
    const n = byPath.get(row.path);
    if (n) addTo(index.aliases, fold(row.alias), n);
  }
  return index;
}

type Resolution = { notes: Note[]; via: 'title' | 'alias' } | null;

function lookup(index: Index, text: string): Resolution {
  const key = fold(text);
  const byTitle = index.titles.get(key);
  if (byTitle) return { notes: byTitle, via: 'title' };
  const byAlias = index.aliases.get(key);
  if (byAlias) return { notes: byAlias, via: 'alias' };
  return null;
}

const TRAILING_PARENTHETICAL = /^(.*\S)\s*\([^()]*\)$/;

function resolve(index: Index, value: string): (Resolution & { confidence: 'high' | 'lower' }) | null {
  const text = stripWikilink(value);
  const exact = lookup(index, text);
  if (exact) return { ...exact, confidence: 'high' };
  const stem = TRAILING_PARENTHETICAL.exec(text)?.[1];
  const fallback = stem ? lookup(index, stem) : null;
  return fallback ? { ...fallback, confidence: 'lower' } : null;
}

function parseFrontmatter(json: string): Record<string, unknown> {
  try {
    const fm: unknown = JSON.parse(json);
    return fm && typeof fm === 'object' && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type NoteRow = {
  group_id: string;
  path: string;
  title: string;
  dm_only: number;
  gm_only: number;
  frontmatter_json: string;
};

const ref = (n: Note): NoteRef => ({ path: n.path, title: n.title });
const hiddenOf = (...notes: Note[]): Hidden[] => [
  ...(notes.some((n) => n.gmOnly) ? (['gm_only'] as const) : []),
  ...(notes.some((n) => n.dmOnly) ? (['dm_only'] as const) : []),
];

/** Resolves `group` (an id, or a name ignoring case) to one world. */
function pickGroups(all: { id: string; name: string }[], group: string | undefined) {
  if (group === undefined) return all;
  const byId = all.filter((g) => g.id === group);
  const picked = byId.length > 0 ? byId : all.filter((g) => g.name.toLowerCase() === group.toLowerCase());
  if (picked.length !== 1) {
    throw new Error(
      picked.length === 0 ? `no world matches "${group}"` : `"${group}" names ${picked.length} worlds; use its id`,
    );
  }
  return picked;
}

/** Candidate Relationships for every world (or the one named by `group`).
 *  Reads `groups`, `notes`, `aliases` and `note_relations`; writes nothing. */
export function suggestRelations(db: ReadDb, opts: { group?: string } = {}): WorldSuggestions[] {
  const groups = pickGroups(
    db.query<{ id: string; name: string }>('SELECT id, name FROM groups ORDER BY name, id').all(),
    opts.group,
  );
  return groups.map((g) => suggestForGroup(db, g));
}

function suggestForGroup(db: ReadDb, group: { id: string; name: string }): WorldSuggestions {
  const notes: Note[] = db
    .query<NoteRow>(
      'SELECT group_id, path, title, dm_only, gm_only, frontmatter_json FROM notes WHERE group_id = ? ORDER BY path',
    )
    .all(group.id)
    .map((r) => {
      const fm = parseFrontmatter(r.frontmatter_json);
      return { path: r.path, title: r.title, dmOnly: r.dm_only === 1, gmOnly: r.gm_only === 1, kind: parseKind(fm.kind), fm };
    });
  const index = buildIndex(
    notes,
    db.query<{ alias: string; path: string }>('SELECT alias, path FROM aliases WHERE group_id = ?').all(group.id),
  );
  const recorded = new Set(
    db
      .query<{ from_path: string; relation: string; to_path: string }>(
        'SELECT from_path, relation, to_path FROM note_relations WHERE group_id = ?',
      )
      .all(group.id)
      .map((r) => [r.from_path, r.relation, r.to_path].join('\0')),
  );

  const candidates: Candidate[] = [];
  const ambiguous: Ambiguous[] = [];
  const unresolved = new Map<string, UnresolvedValue>();
  const counts = { candidates: 0, ambiguous: 0, unresolved: 0, placeholders: 0, alreadyRecorded: 0, selfReferences: 0 };

  for (const source of notes) {
    if (!source.kind || !SOURCE_KINDS.includes(source.kind)) continue;
    for (const field of FIELDS) {
      const relation = FIELD_RELATIONS[field];
      for (const value of fieldValues(source.fm[field])) {
        if (isPlaceholder(value)) {
          counts.placeholders++;
          continue;
        }
        const hit = resolve(index, value);
        if (!hit) {
          const shown = stripWikilink(value);
          const key = `${field}\0${fold(shown)}`;
          const entry = unresolved.get(key) ?? { field, value: shown, count: 0 };
          entry.count++;
          unresolved.set(key, entry);
          counts.unresolved++;
          continue;
        }
        if (hit.notes.length > 1) {
          ambiguous.push({ from: ref(source), relation, field, value, matches: hit.notes.map(ref) });
          counts.ambiguous++;
          continue;
        }
        const target = hit.notes[0]!;
        if (target.path === source.path) {
          counts.selfReferences++;
          continue;
        }
        const pair = canonicalPair(source.path, relation, target.path);
        if (recorded.has([pair.from, pair.relation, pair.to].join('\0'))) {
          counts.alreadyRecorded++;
          continue;
        }
        candidates.push({
          from: ref(source),
          relation,
          to: ref(target),
          field,
          confidence: hit.confidence,
          value,
          hidden: hiddenOf(source, target),
        });
        counts.candidates++;
      }
    }
  }

  return {
    groupId: group.id,
    groupName: group.name,
    candidates,
    ambiguous,
    unresolved: [...unresolved.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    counts,
  };
}

/** The readable report: per world, the candidates, the ambiguous values,
 *  a summary and the unresolved values ranked by use. */
export function formatSuggestions(worlds: WorldSuggestions[]): string {
  const out: string[] = [];
  for (const w of worlds) {
    out.push(`== ${w.groupName} (${w.groupId})`, '');
    out.push(`Candidates (${w.candidates.length})`);
    for (const c of w.candidates) {
      const marks = c.hidden.map((h) => ` [${h}]`).join('');
      const note = c.confidence === 'lower' ? `  (from "${c.value}")` : '';
      out.push(`  ${c.from.title} -> ${c.relation} -> ${c.to.title}  [${c.field}, ${c.confidence}]${marks}${note}`);
    }
    if (w.ambiguous.length > 0) {
      out.push('', `Ambiguous (${w.ambiguous.length})`);
      for (const a of w.ambiguous) {
        out.push(`  ${a.from.title} -> ${a.relation} -> "${a.value}"  [${a.field}] matches ${a.matches.map((m) => m.path).join(', ')}`);
      }
    }
    const n = w.counts;
    out.push(
      '',
      `Summary: ${n.candidates} candidates, ${n.ambiguous} ambiguous, ${n.unresolved} unresolved, ` +
        `${n.placeholders} placeholder-skipped, ${n.alreadyRecorded} already recorded, ${n.selfReferences} self-references skipped`,
    );
    if (w.unresolved.length > 0) {
      out.push('', 'Unresolved values, most used first (Notes worth creating)');
      for (const u of w.unresolved) out.push(`  ${String(u.count).padStart(3)}  ${u.field}  ${u.value}`);
    }
    out.push('');
  }
  return out.join('\n');
}
