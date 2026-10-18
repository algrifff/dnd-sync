// Pure helpers behind ConnectionsPanel: no React, no DB, so they can be
// tested directly (docs/adr/0003-connections-panel-and-manual-relationships.md).

import type { BacklinkRow, OutgoingLinkRow } from '@/lib/notes';
import type { RelationView } from '@/lib/relations';

/** The pieces of a Relationship the panel shows. Derived from
 *  `RelationView`, so the two cannot drift. */
export type RelationRow = Pick<
  RelationView,
  'relation' | 'label' | 'path' | 'title' | 'sessionPath' | 'sessionTitle' | 'createdBy'
>;

export type RelationGroup = { label: string; rows: RelationRow[] };

/** `out`: this Note links to it. `in`: it links here. `both`: each links
 *  to the other. */
export type LinkDirection = 'out' | 'in' | 'both';

export type LinkRow = {
  path: string;
  title: string;
  direction: LinkDirection;
  /** The `note_links` edges the × removes, as `{ fromPath, toPath }`. */
  edges: Array<{ fromPath: string; toPath: string }>;
};

export const ARROWS: Record<LinkDirection, string> = { out: '→', in: '←', both: '↔' };

/** Groups Relationships by their label, groups sorted by label and rows
 *  by title, so the panel reads the same on every load. */
export function groupRelations(rows: readonly RelationRow[]): RelationGroup[] {
  const byLabel = new Map<string, RelationRow[]>();
  for (const r of rows) {
    const list = byLabel.get(r.label);
    if (list) list.push(r);
    else byLabel.set(r.label, [r]);
  }
  return [...byLabel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => ({
      label,
      rows: [...list].sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path)),
    }));
}

/** Merges backlinks and outgoing links into one row per other Note with a
 *  direction. Any path in `exclude` (the ones already listed under
 *  Relationships) is left out. A Note that links to itself is ignored. */
export function mergeLinks(opts: {
  currentPath: string;
  backlinks: readonly BacklinkRow[];
  outgoing: readonly OutgoingLinkRow[];
  exclude?: ReadonlySet<string>;
}): LinkRow[] {
  const { currentPath, exclude } = opts;
  const rows = new Map<string, LinkRow>();
  const upsert = (path: string, title: string, dir: 'out' | 'in'): void => {
    if (path === currentPath || exclude?.has(path)) return;
    const edge =
      dir === 'out' ? { fromPath: currentPath, toPath: path } : { fromPath: path, toPath: currentPath };
    const existing = rows.get(path);
    if (!existing) {
      rows.set(path, { path, title, direction: dir, edges: [edge] });
      return;
    }
    if (existing.direction !== dir) existing.direction = 'both';
    existing.edges.push(edge);
  };
  for (const l of opts.outgoing) upsert(l.to_path, l.title, 'out');
  for (const b of opts.backlinks) upsert(b.from_path, b.title, 'in');
  return [...rows.values()].sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
}

/** The caption under a Relationship row: its Session, else who added it. */
export function relationProvenance(
  r: Pick<RelationRow, 'sessionPath' | 'sessionTitle' | 'createdBy'>,
): { kind: 'session'; path: string; title: string } | { kind: 'author'; name: string } | null {
  if (r.sessionPath) {
    return { kind: 'session', path: r.sessionPath, title: r.sessionTitle || baseName(r.sessionPath) };
  }
  return r.createdBy ? { kind: 'author', name: r.createdBy } : null;
}

export function baseName(p: string): string {
  const last = p.split('/').pop() ?? p;
  return last.replace(/\.(md|canvas)$/i, '');
}

export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
