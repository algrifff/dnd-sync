// Graph payloads for the mind-map page + mini-graph. Returns the
// subset of notes matching a scope (all / folder / tag) together with
// their tag lists and the edges that run entirely within that subset
// (filtered out-of-scope endpoints). Degree is the edge count per
// node, pre-computed so the client doesn't need to recount.
//
// Cost is bounded by the group's note count — a single SELECT per
// table plus O(edges) filtering. At the 1500-note scale called out
// in the plan this stays well under a millisecond.

import { createHash } from 'node:crypto';
import { getDb } from './db';

export type GraphNode = {
  id: string;          // note path
  title: string;
  tags: string[];
  degree: number;
};

export type GraphEdge = {
  source: string;
  target: string;
};

export type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  updatedAt: number;
  etag: string;
};

export type GraphScope =
  | { kind: 'all' }
  | { kind: 'folder'; path: string }
  | { kind: 'tag'; tag: string };

/** Parse a `?scope=` query value. Accepts `all`, `folder:<path>`,
 *  `tag:<tag>`; defaults to all on anything unrecognised. */
export function parseScope(raw: string | null): GraphScope {
  if (!raw || raw === 'all') return { kind: 'all' };
  if (raw.startsWith('folder:')) {
    const path = raw.slice('folder:'.length).replace(/^\/+|\/+$/g, '');
    if (!path) return { kind: 'all' };
    return { kind: 'folder', path };
  }
  if (raw.startsWith('tag:')) {
    const tag = raw.slice('tag:'.length).toLowerCase();
    if (!tag) return { kind: 'all' };
    return { kind: 'tag', tag };
  }
  return { kind: 'all' };
}

export type GraphMode = 'player' | 'gm';

export function buildGraph(
  groupId: string,
  scope: GraphScope,
  opts: { mode?: GraphMode; hideDmOnly: boolean },
): GraphPayload {
  const db = getDb();
  const gmFlag = opts.mode === 'gm' ? 1 : 0;
  // Viewers don't see dm_only notes. gm_only is already namespace-
  // selected by `mode` above, so it needs no second predicate here.
  const dmClause = opts.hideDmOnly ? ' AND dm_only = 0' : '';
  const dmClauseN = opts.hideDmOnly ? ' AND n.dm_only = 0' : '';

  // Fetch the scoped note set first; everything else joins off these.
  type NoteRow = { path: string; title: string; updatedAt: number };
  let noteRows: NoteRow[] = [];
  if (scope.kind === 'all') {
    noteRows = db
      .query<NoteRow, [string, number]>(
        `SELECT path, title, updated_at AS updatedAt
           FROM notes WHERE group_id = ? AND gm_only = ?${dmClause}`,
      )
      .all(groupId, gmFlag);
  } else if (scope.kind === 'folder') {
    noteRows = db
      .query<NoteRow, [string, number, string, string]>(
        `SELECT path, title, updated_at AS updatedAt
           FROM notes
          WHERE group_id = ? AND gm_only = ? AND (path = ? OR path LIKE ? || '/%')${dmClause}`,
      )
      .all(groupId, gmFlag, scope.path, scope.path);
  } else {
    noteRows = db
      .query<NoteRow, [string, number, string]>(
        `SELECT n.path AS path, n.title AS title, n.updated_at AS updatedAt
           FROM notes n
           JOIN tags t ON t.group_id = n.group_id AND t.path = n.path
          WHERE n.group_id = ? AND n.gm_only = ? AND t.tag = ?${dmClauseN}`,
      )
      .all(groupId, gmFlag, scope.tag);
  }

  const pathSet = new Set<string>(noteRows.map((r) => r.path));
  const maxUpdatedAt = noteRows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), 0);

  // Bulk-fetch tags + edges for the group once; filter to the scoped
  // note set in memory.
  const tagRows = db
    .query<{ path: string; tag: string }, [string]>(
      `SELECT path, tag FROM tags WHERE group_id = ?`,
    )
    .all(groupId);
  const tagsByPath = new Map<string, string[]>();
  for (const r of tagRows) {
    if (!pathSet.has(r.path)) continue;
    const bucket = tagsByPath.get(r.path);
    if (bucket) bucket.push(r.tag);
    else tagsByPath.set(r.path, [r.tag]);
  }
  for (const list of tagsByPath.values()) list.sort();

  const edgeRows = db
    .query<{ from_path: string; to_path: string }, [string]>(
      `SELECT from_path, to_path FROM note_links WHERE group_id = ?`,
    )
    .all(groupId);

  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  for (const r of edgeRows) {
    // Skip dangling-link markers (`__orphan__:...`) and any edge with
    // either endpoint outside the scoped node set.
    if (r.from_path.startsWith('__orphan__:') || r.to_path.startsWith('__orphan__:')) continue;
    if (!pathSet.has(r.from_path) || !pathSet.has(r.to_path)) continue;
    edges.push({ source: r.from_path, target: r.to_path });
    degree.set(r.from_path, (degree.get(r.from_path) ?? 0) + 1);
    degree.set(r.to_path, (degree.get(r.to_path) ?? 0) + 1);
  }

  const nodes: GraphNode[] = noteRows.map((r) => ({
    id: r.path,
    title: r.title || fallbackTitle(r.path),
    tags: tagsByPath.get(r.path) ?? [],
    degree: degree.get(r.path) ?? 0,
  }));

  return {
    nodes,
    edges,
    updatedAt: maxUpdatedAt,
    etag: `"graph-${opts.mode ?? 'player'}${opts.hideDmOnly ? '-nodm' : ''}-${scope.kind}-${noteRows.length}-${maxUpdatedAt}-${sha1Short(scopeKey(scope))}"`,
  };
}

/** 1-hop neighbourhood around a single note. Nodes = the note + every
 *  direct neighbour (in or out). Edges = links between any pair in
 *  that node set (so 2-hop shortcuts between neighbours are visible). */
export function buildNeighborhood(
  groupId: string,
  path: string,
  depth = 1,
  opts: { mode?: GraphMode; hideDmOnly: boolean },
): GraphPayload | null {
  if (depth < 1) depth = 1;
  if (depth > 2) depth = 2;
  const db = getDb();
  const gmFlag = opts.mode === 'gm' ? 1 : 0;
  const dmClause = opts.hideDmOnly ? ' AND dm_only = 0' : '';

  const root = db
    .query<{ path: string; title: string; updatedAt: number }, [string, number, string]>(
      `SELECT path, title, updated_at AS updatedAt
         FROM notes WHERE group_id = ? AND gm_only = ? AND path = ?${dmClause}`,
    )
    .get(groupId, gmFlag, path);
  if (!root) return null;

  // Expand the BFS frontier with ONE QUERY PER DIRECTION PER HOP —
  // batched with `from_path/to_path IN (...)` across every node
  // currently in the frontier — instead of one query per node per
  // direction per hop (dozens-to-hundreds of round-trips on a
  // well-connected hub note). depth is capped at 2 above, so this is at
  // most 4 note_links queries total, each served by the
  // note_links_from / note_links_to indexes (v31).
  //
  // A prior version of this fix bulk-fetched ALL notes + ALL note_links
  // for the group up front (mirroring buildGraph's scope: 'all' path)
  // and expanded purely in memory. Benchmarked against the real
  // pre-rewrite implementation (bench-neighborhood3/4, not checked in)
  // that was a net loss for the common case: buildGraph always needs
  // the whole group anyway, but buildNeighborhood's entire purpose is a
  // LOCAL radius around one note, so pulling the whole group turns an
  // O(neighbourhood) op into O(total group size) — at the 1500-note
  // scale this file's header comment documents as the design target, a
  // small-degree note (the common case) got ~1.75x SLOWER, and an
  // isolated small hub in a 10k-note vault got ~2x slower still. The
  // per-hop batched IN(...) query below keeps cost bounded by the
  // actual radius explored (like the original), while still collapsing
  // "one query per node" into "one query per hop" (like the mirrored
  // buildGraph approach) — it dominated both alternatives at every
  // scale tested (small hub, wide hub, 1500-note and 10k-note groups).
  //
  // Both queries JOIN `notes` and re-apply the exact same gm_only/dm_only
  // predicate as the root lookup — a hop can only traverse THROUGH a
  // note the caller can actually see. Without this, a note reachable
  // only via a hidden note would surface in `neighbours` (and later in
  // `nodes`) as an unexplainable orphan, leaking the hidden note's
  // existence + adjacency even though its own title/body stay hidden.
  const dmClauseN = opts.hideDmOnly ? ' AND n.dm_only = 0' : '';
  const neighbours = new Set<string>([root.path]);
  let frontier: string[] = [root.path];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const placeholders = frontier.map(() => '?').join(',');
    const outSql = `SELECT nl.to_path AS to_path
                       FROM note_links nl
                       JOIN notes n ON n.group_id = nl.group_id AND n.path = nl.to_path
                      WHERE nl.group_id = ? AND nl.from_path IN (${placeholders}) AND n.gm_only = ?${dmClauseN}`;
    const inSql = `SELECT nl.from_path AS from_path
                      FROM note_links nl
                      JOIN notes n ON n.group_id = nl.group_id AND n.path = nl.from_path
                     WHERE nl.group_id = ? AND nl.to_path IN (${placeholders}) AND n.gm_only = ?${dmClauseN}`;
    const outRows = db
      .query<{ to_path: string }, [string, ...string[], number]>(outSql)
      .all(groupId, ...frontier, gmFlag);
    const inRows = db
      .query<{ from_path: string }, [string, ...string[], number]>(inSql)
      .all(groupId, ...frontier, gmFlag);

    const next: string[] = [];
    for (const r of outRows) {
      if (r.to_path.startsWith('__orphan__:')) continue;
      if (!neighbours.has(r.to_path)) {
        neighbours.add(r.to_path);
        next.push(r.to_path);
      }
    }
    for (const r of inRows) {
      if (!neighbours.has(r.from_path)) {
        neighbours.add(r.from_path);
        next.push(r.from_path);
      }
    }
    frontier = next;
  }

  // Materialise the sub-graph bounded to the discovered neighbourhood
  // (not the whole group) so this stays cheap regardless of total
  // group size — the note_links query below uses the same
  // note_links_from/to indexes via the IN (...) predicates.
  const placeholders = [...neighbours].map(() => '?').join(',');
  const noteRows = db
    .query<{ path: string; title: string; updatedAt: number }, [string, number, ...string[]]>(
      `SELECT path, title, updated_at AS updatedAt
         FROM notes
        WHERE group_id = ? AND gm_only = ? AND path IN (${placeholders})${dmClause}`,
    )
    .all(groupId, gmFlag, ...neighbours);

  const pathSet = new Set<string>(noteRows.map((r) => r.path));
  const maxUpdatedAt = noteRows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), 0);

  const tagRows = db
    .query<{ path: string; tag: string }, [string, ...string[]]>(
      `SELECT path, tag FROM tags WHERE group_id = ? AND path IN (${placeholders})`,
    )
    .all(groupId, ...neighbours);
  const tagsByPath = new Map<string, string[]>();
  for (const r of tagRows) {
    if (!pathSet.has(r.path)) continue;
    const bucket = tagsByPath.get(r.path);
    if (bucket) bucket.push(r.tag);
    else tagsByPath.set(r.path, [r.tag]);
  }
  for (const list of tagsByPath.values()) list.sort();

  // Bulk-fetch (single `group_id = ?` bind) and filter to pathSet in
  // memory rather than a double `IN (...) AND IN (...)` — benchmarked:
  // on a well-connected hub, a materialisation query with two ~700-item
  // IN-lists (1400+ bound params) was measurably SLOWER than fetching
  // the group's full edge set and filtering in memory, even though the
  // latter scans more rows. This step runs once per call (not per hop),
  // so it stays cheap at the group sizes this app targets (see file
  // header comment) — the per-hop win above is what actually mattered
  // for the hub-note N+1 problem.
  const edgeRows = db
    .query<{ from_path: string; to_path: string }, [string]>(
      `SELECT from_path, to_path FROM note_links WHERE group_id = ?`,
    )
    .all(groupId);

  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  for (const r of edgeRows) {
    if (r.from_path.startsWith('__orphan__:') || r.to_path.startsWith('__orphan__:')) continue;
    if (!pathSet.has(r.from_path) || !pathSet.has(r.to_path)) continue;
    edges.push({ source: r.from_path, target: r.to_path });
    degree.set(r.from_path, (degree.get(r.from_path) ?? 0) + 1);
    degree.set(r.to_path, (degree.get(r.to_path) ?? 0) + 1);
  }

  const nodes: GraphNode[] = noteRows.map((r) => ({
    id: r.path,
    title: r.title || fallbackTitle(r.path),
    tags: tagsByPath.get(r.path) ?? [],
    degree: degree.get(r.path) ?? 0,
  }));

  return {
    nodes,
    edges,
    updatedAt: maxUpdatedAt,
    etag: `"nbhd-${opts.mode ?? 'player'}${opts.hideDmOnly ? '-nodm' : ''}-${depth}-${nodes.length}-${maxUpdatedAt}-${sha1Short(path)}"`,
  };
}

function scopeKey(s: GraphScope): string {
  if (s.kind === 'all') return 'all';
  if (s.kind === 'folder') return `folder:${s.path}`;
  return `tag:${s.tag}`;
}

function sha1Short(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 10);
}

function fallbackTitle(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(md|canvas)$/i, '');
}
