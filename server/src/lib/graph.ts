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

export function buildGraph(groupId: string, scope: GraphScope): GraphPayload {
  const db = getDb();

  // Fetch the scoped note set first; everything else joins off these.
  type NoteRow = { path: string; title: string; updatedAt: number };
  let noteRows: NoteRow[] = [];
  if (scope.kind === 'all') {
    noteRows = db
      .query<NoteRow, [string]>(
        `SELECT path, title, updated_at AS updatedAt
           FROM notes WHERE group_id = ?`,
      )
      .all(groupId);
  } else if (scope.kind === 'folder') {
    noteRows = db
      .query<NoteRow, [string, string, string]>(
        `SELECT path, title, updated_at AS updatedAt
           FROM notes
          WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
      )
      .all(groupId, scope.path, scope.path);
  } else {
    noteRows = db
      .query<NoteRow, [string, string]>(
        `SELECT n.path AS path, n.title AS title, n.updated_at AS updatedAt
           FROM notes n
           JOIN tags t ON t.group_id = n.group_id AND t.path = n.path
          WHERE n.group_id = ? AND t.tag = ?`,
      )
      .all(groupId, scope.tag);
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
    etag: `"graph-${scope.kind}-${noteRows.length}-${maxUpdatedAt}-${sha1Short(scopeKey(scope))}"`,
  };
}

/** 1-hop neighbourhood around a single note. Nodes = the note + every
 *  direct neighbour (in or out). Edges = links between any pair in
 *  that node set (so 2-hop shortcuts between neighbours are visible). */
export function buildNeighborhood(
  groupId: string,
  path: string,
  depth = 1,
): GraphPayload | null {
  if (depth < 1) depth = 1;
  if (depth > 2) depth = 2;
  const db = getDb();

  const root = db
    .query<{ path: string; title: string; updatedAt: number }, [string, string]>(
      `SELECT path, title, updated_at AS updatedAt
         FROM notes WHERE group_id = ? AND path = ?`,
    )
    .get(groupId, path);
  if (!root) return null;

  const neighbours = new Set<string>([root.path]);
  let frontier = new Set<string>([root.path]);
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>();
    for (const p of frontier) {
      const outRows = db
        .query<{ to_path: string }, [string, string]>(
          `SELECT to_path FROM note_links WHERE group_id = ? AND from_path = ?`,
        )
        .all(groupId, p);
      const inRows = db
        .query<{ from_path: string }, [string, string]>(
          `SELECT from_path FROM note_links WHERE group_id = ? AND to_path = ?`,
        )
        .all(groupId, p);
      for (const r of outRows) {
        if (r.to_path.startsWith('__orphan__:')) continue;
        if (!neighbours.has(r.to_path)) {
          neighbours.add(r.to_path);
          next.add(r.to_path);
        }
      }
      for (const r of inRows) {
        if (!neighbours.has(r.from_path)) {
          neighbours.add(r.from_path);
          next.add(r.from_path);
        }
      }
    }
    frontier = next;
  }

  // Materialise the sub-graph by re-using buildGraph logic over the
  // restricted node set. Simpler than duplicating queries.
  const placeholders = [...neighbours].map(() => '?').join(',');
  const noteRows = db
    .query<{ path: string; title: string; updatedAt: number }, [string, ...string[]]>(
      `SELECT path, title, updated_at AS updatedAt
         FROM notes
        WHERE group_id = ? AND path IN (${placeholders})`,
    )
    .all(groupId, ...neighbours);

  const pathSet = new Set<string>(noteRows.map((r) => r.path));
  const maxUpdatedAt = noteRows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), 0);

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
    etag: `"nbhd-${depth}-${nodes.length}-${maxUpdatedAt}-${sha1Short(path)}"`,
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
