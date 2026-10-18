// Relationships: typed, authored facts about how one Note stands to
// another (docs/adr/0002-typed-relationships.md). This module is the
// only place that reads or writes note_relations.
//
// The stored type, inverse and symmetry all come from the shared table
// in @compendium/shared. Every Relationship also has a plain manual
// note_links row, so the graph and backlinks show the connection.

import {
  canonicalPair,
  inverseOf,
  RELATIONS,
  type RelationName,
  type RelationType,
} from '@compendium/shared';
import { getDb } from '@/lib/db';
import { visibilityFor } from '@/lib/notes';
import type { Role } from '@/lib/wrap-up';

/** Records `from relation to`. Adding it again, from either end of a
 *  symmetric type, changes nothing and reports `unchanged`. */
export function addRelation(opts: {
  groupId: string;
  from: string;
  relation: RelationType;
  to: string;
  sessionPath: string | null;
  userId: string | null;
}): { status: 'added' | 'unchanged' } {
  const pair = canonicalPair(opts.from, opts.relation, opts.to);
  const db = getDb();
  let added = false;
  db.transaction(() => {
    added =
      db
        .query(
          `INSERT INTO note_relations
             (group_id, from_path, relation, to_path, session_path, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(opts.groupId, pair.from, pair.relation, pair.to, opts.sessionPath, opts.userId, Date.now())
        .changes > 0;
    // Marked manual even when the body already links the pair, so the
    // link outlives an edit that removes the wikilink.
    db.query(
      `INSERT INTO note_links (group_id, from_path, to_path, is_manual)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (group_id, from_path, to_path) DO UPDATE SET is_manual = 1`,
    ).run(opts.groupId, pair.from, pair.to);
  })();
  return { status: added ? 'added' : 'unchanged' };
}

/** Removes the one stored row for `from relation to`, canonicalised like
 *  `addRelation`. The plain link it came with stays. */
export function removeRelation(opts: {
  groupId: string;
  from: string;
  relation: RelationType;
  to: string;
}): { status: 'removed' | 'missing' } {
  const pair = canonicalPair(opts.from, opts.relation, opts.to);
  const removed =
    getDb()
      .query('DELETE FROM note_relations WHERE group_id = ? AND from_path = ? AND relation = ? AND to_path = ?')
      .run(opts.groupId, pair.from, pair.relation, pair.to).changes > 0;
  return { status: removed ? 'removed' : 'missing' };
}

/** A Relationship as read from one of its Notes. */
export type RelationView = {
  /** The type from this Note's side: `has_member` when it is the group. */
  relation: RelationName;
  label: string;
  path: string;
  title: string;
  /** The Session that established it, when the reader may see it. */
  sessionPath: string | null;
  /** The Session's title, when `sessionPath` is set. */
  sessionTitle: string | null;
  /** Display name of the person who added it, when known. */
  createdBy: string | null;
  createdAt: number;
};

type Row = {
  outgoing: 0 | 1;
  relation: RelationType;
  path: string;
  title: string;
  session_path: string | null;
  session_title: string | null;
  created_by_name: string | null;
  created_at: number;
};

/** Every Relationship `path` takes part in, from either end, that `role`
 *  may see: both Notes visible to them. Nothing when `path` itself is
 *  hidden or missing. */
export function listRelations(opts: { groupId: string; role: Role; path: string }): RelationView[] {
  const vis = visibilityFor(opts.role);
  const hidden = (alias: string): string =>
    `${vis.hideDmOnly ? ` AND ${alias}.dm_only = 0` : ''}${vis.hideGmOnly ? ` AND ${alias}.gm_only = 0` : ''}`;
  const side = (outgoing: 0 | 1): string => {
    const [me, other] = outgoing ? ['from_path', 'to_path'] : ['to_path', 'from_path'];
    return `SELECT ${outgoing} AS outgoing, r.relation AS relation, o.path AS path, o.title AS title,
                   s.path AS session_path, s.title AS session_title,
                   COALESCE(NULLIF(u.display_name, ''), u.username) AS created_by_name,
                   r.created_at
              FROM note_relations r
              JOIN notes me ON me.group_id = r.group_id AND me.path = r.${me}${hidden('me')}
              JOIN notes o ON o.group_id = r.group_id AND o.path = r.${other}${hidden('o')}
              LEFT JOIN notes s ON s.group_id = r.group_id AND s.path = r.session_path${hidden('s')}
              LEFT JOIN users u ON u.id = r.created_by
             WHERE r.group_id = ? AND r.${me} = ?`;
  };
  const rows = getDb()
    .query<Row, [string, string, string, string]>(
      `${side(1)} UNION ALL ${side(0)} ORDER BY title, path, relation`,
    )
    .all(opts.groupId, opts.path, opts.groupId, opts.path);
  return rows.map((r) => ({
    relation: r.outgoing ? r.relation : inverseOf(r.relation),
    label: r.outgoing ? RELATIONS[r.relation].label : RELATIONS[r.relation].inverseLabel,
    path: r.path,
    title: r.title,
    sessionPath: r.session_path,
    sessionTitle: r.session_title,
    createdBy: r.created_by_name,
    createdAt: r.created_at,
  }));
}

/** Every stored (forward) Relationship in the world, unfiltered. The
 *  caller must drop rows whose ends the reader may not see; graph.ts
 *  does so against its already-gated node set. */
export function listWorldRelations(
  groupId: string,
): Array<{ from: string; relation: RelationType; to: string }> {
  return getDb()
    .query<{ from: string; relation: RelationType; to: string }, [string]>(
      `SELECT from_path AS "from", relation, to_path AS "to" FROM note_relations
        WHERE group_id = ? ORDER BY from_path, relation, to_path`,
    )
    .all(groupId);
}

/** Carries a Note's Relationships from `from` to `to` inside the caller's
 *  move transaction, including those it established as a Session. A row
 *  that would duplicate one already at `to` merges into it, and a
 *  symmetric row is re-sorted for its new path. */
export function repointRelations(groupId: string, from: string, to: string): void {
  const db = getDb();
  db.query('UPDATE note_relations SET session_path = ? WHERE group_id = ? AND session_path = ?')
    .run(to, groupId, from);
  // OR IGNORE leaves behind a row that would collide or would relate the
  // Note to itself (the CHECK), and the DELETE then drops it.
  for (const col of ['from_path', 'to_path'] as const) {
    db.query(`UPDATE OR IGNORE note_relations SET ${col} = ? WHERE group_id = ? AND ${col} = ?`)
      .run(to, groupId, from);
    db.query(`DELETE FROM note_relations WHERE group_id = ? AND ${col} = ?`).run(groupId, from);
  }
  const touching = db
    .query<{ from_path: string; relation: RelationType; to_path: string }, [string, string, string]>(
      'SELECT from_path, relation, to_path FROM note_relations WHERE group_id = ? AND (from_path = ? OR to_path = ?)',
    )
    .all(groupId, to, to);
  for (const r of touching) {
    const pair = canonicalPair(r.from_path, r.relation, r.to_path);
    if (pair.from === r.from_path) continue;
    const key = [groupId, r.from_path, r.relation, r.to_path] as const;
    db.query(
      `UPDATE OR IGNORE note_relations SET from_path = ?, to_path = ?
        WHERE group_id = ? AND from_path = ? AND relation = ? AND to_path = ?`,
    ).run(pair.from, pair.to, ...key);
    db.query('DELETE FROM note_relations WHERE group_id = ? AND from_path = ? AND relation = ? AND to_path = ?')
      .run(...key);
  }
}

/** Drops every Relationship of a Note being deleted, inside the caller's
 *  transaction, and forgets it as the Session behind any other. */
export function deleteRelationsOf(groupId: string, path: string): void {
  const db = getDb();
  db.query('DELETE FROM note_relations WHERE group_id = ? AND (from_path = ? OR to_path = ?)')
    .run(groupId, path, path);
  db.query('UPDATE note_relations SET session_path = NULL WHERE group_id = ? AND session_path = ?')
    .run(groupId, path);
}
