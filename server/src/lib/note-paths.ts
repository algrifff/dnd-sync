// Note paths: carrying a Note through rename, move, copy and delete.
//
// A Note's path is its key almost everywhere: links, tags, aliases, the
// derived indexes, Suggestions, Relationships, a pending Wrap-up, the
// wikilinks in other Notes' bodies. This module is the one place that
// knows every one of them, so a path change is either carried
// everywhere or not at all.
//
//   renameNotes  one Note, a batch, or a whole folder
//   copyNote     a new Note at a new path from an existing one
//   deleteNotes  one Note, a batch, or a whole folder
//
// Each runs its own transaction. A caller that has to write something
// in the same transaction passes `inTransaction`; it runs last, after
// every path is carried (so it addresses Notes by their new paths), and
// a throw from it rolls the whole operation back.
//
// Policy stays with the caller: auth, visibility, assertMoveAllowed, and
// draining open editors before the write. After a rename the caller
// also evicts the moved Notes' own editors, since only it knows whether
// it drained them with a write token.
//
// notes_fts follows the notes row by trigger. note_relations rows are
// written by lib/relations.ts, which this module calls.

import { randomUUID } from 'node:crypto';
import { getDb, isUniqueConstraintError } from './db';
import { slugify } from './slugify';
import { closeDocumentConnections } from '../collab/server';
import { findWikilinkLinkers, rewriteWikilinksForLinkers, type Rename } from './move-rewrite';
import { deriveFolderIndexesFor } from './campaign-index';
import { deriveAllIndexes } from './derive-indexes';
import { deleteRelationsOf, repointRelations } from './relations';

export type PathMove = { from: string; to: string };

/** `not_found`: a source Note is gone. `exists`: a destination is taken.
 *  Nothing was written. */
export type PathError = { ok: false; error: 'not_found' | 'exists'; path: string };

/** Every column that holds a Note path, as (table, column, kind). Each
 *  one is carried on rename. When you add a table keyed by a Note path,
 *  add it here and to note-paths.test.ts, whose suite checks every row.
 *
 *  A rename's destination holds no Note, so what a row already there
 *  means depends on the kind:
 *    own  the row belongs to the Note at that path. One already at the
 *         destination is an orphan a past delete left behind: it is
 *         cleared and the moving row takes its place, never the other
 *         way round (a Suggestion or a pending Wrap-up is user work).
 *    ref  another Note's row naming this path, which may be a path no
 *         Note holds yet (a dangling [[wikilink]]). A moving row that
 *         would collide is the same reference, so the two merge. */
const PATH_COLUMNS = [
  ['note_links', 'from_path', 'own'],
  ['note_links', 'to_path', 'ref'],
  ['tags', 'path', 'own'],
  ['aliases', 'path', 'own'],
  ['characters', 'note_path', 'own'],
  ['character_campaigns', 'note_path', 'own'],
  ['session_notes', 'note_path', 'own'],
  ['items', 'note_path', 'own'],
  ['locations', 'note_path', 'own'],
  ['locations', 'parent_path', 'ref'],
  ['creatures', 'note_path', 'own'],
  // A Suggestion belongs to both its Character and its Session.
  ['character_suggestions', 'character_path', 'own'],
  ['character_suggestions', 'session_path', 'own'],
] as const;

// ── Rename ─────────────────────────────────────────────────────────────

/** Moves each Note in `moves` to its new path and carries every
 *  path-keyed row with it. With `folder`, the moves are that folder's
 *  Notes: its folder markers and campaign rows move too, and a
 *  `[[Folder]]` wikilink follows like a Note's.
 *
 *  Wikilinks to a moved Note are rewritten in the bodies of the Notes
 *  that hold them (including Notes that moved in the same batch), and
 *  those Notes' editors are evicted. Folder indexes on both sides are
 *  refreshed. */
export async function renameNotes(opts: {
  groupId: string;
  userId: string;
  moves: readonly PathMove[];
  folder?: PathMove;
  inTransaction?: () => void;
}): Promise<{ ok: true } | PathError> {
  const { groupId, userId, folder } = opts;
  const moves = opts.moves.filter((m) => m.from !== m.to);
  const db = getDb();

  // A folder path is a link target too (`[[Characters]]`), and so is
  // every folder nested under it.
  const folderRenames: Rename[] = folder ? [folder, ...nestedFolderRenames(groupId, folder)] : [];
  const renames: Rename[] = [...moves, ...folderRenames];
  if (renames.length === 0) {
    if (opts.inTransaction) db.transaction(opts.inTransaction)();
    return { ok: true };
  }

  // Linkers must be found BEFORE the transaction: it repoints their
  // edges, after which nothing points at the old paths any more. A
  // linker that is itself moving is rewritten at its new path.
  const newPathOf = new Map(moves.map((m) => [m.from, m.to]));
  const linkers = findWikilinkLinkers(groupId, renames.map((r) => r.from)).map(
    (p) => newPathOf.get(p) ?? p,
  );

  let failed: PathError | null = null;
  try {
    db.transaction(() => {
      failed = checkMoves(groupId, moves);
      if (failed) return;
      // characters, character_campaigns, session_notes, items, locations
      // and creatures hold FKs on notes(group_id, path) with no ON UPDATE
      // CASCADE. Check them at COMMIT, once every row is carried.
      db.exec('PRAGMA defer_foreign_keys = 1');
      const now = Date.now();
      for (const m of moves) {
        db.query('UPDATE notes SET path = ?, updated_at = ?, updated_by = ? WHERE group_id = ? AND path = ?')
          .run(m.to, now, userId, groupId, m.from);
        carryPath(groupId, m.from, m.to);
      }
      if (folder) carryFolder(groupId, folder);
      repointWrapUps(groupId, newPathOf);
      opts.inTransaction?.();
    })();
  } catch (err) {
    // A writer on another connection can still take a destination after
    // the check. The transaction has rolled back.
    const taken = isUniqueConstraintError(err) ? moves.find((m) => noteExists(groupId, m.to)) : undefined;
    if (taken) return { ok: false, error: 'exists', path: taken.to };
    throw err;
  }
  if (failed) return failed;

  await afterCommit('wikilink rewrite', async () => {
    const touched = rewriteWikilinksForLinkers(groupId, linkers, renames, userId);
    for (const linker of touched) await closeDocumentConnections(groupId, linker);
  });
  await afterCommit('folder index refresh', () =>
    deriveFolderIndexesFor(groupId, renames.flatMap((r) => [r.from, r.to]), { userId }),
  );
  return { ok: true };
}

function checkMoves(groupId: string, moves: readonly PathMove[]): PathError | null {
  const sources = new Set(moves.map((m) => m.from));
  const targets = new Set<string>();
  for (const m of moves) {
    if (!noteExists(groupId, m.from)) return { ok: false, error: 'not_found', path: m.from };
    // A destination is free only if nothing sits there now, nothing else
    // in the batch claims it, and it is not a source still waiting to
    // move (the batch does not do swaps).
    if (noteExists(groupId, m.to) || targets.has(m.to) || sources.has(m.to)) {
      return { ok: false, error: 'exists', path: m.to };
    }
    targets.add(m.to);
  }
  return null;
}

/** Repoints every row naming `from` to `to`; see PATH_COLUMNS for what
 *  happens to a row already at `to`. */
function carryPath(groupId: string, from: string, to: string): void {
  const db = getDb();
  for (const [table, column, kind] of PATH_COLUMNS) {
    if (kind === 'own') {
      db.query(`DELETE FROM ${table} WHERE group_id = ? AND ${column} = ?`).run(groupId, to);
      db.query(`UPDATE ${table} SET ${column} = ? WHERE group_id = ? AND ${column} = ?`)
        .run(to, groupId, from);
      continue;
    }
    if (table === 'note_links') keepLinkFlags(groupId, from, to);
    // OR IGNORE leaves behind a row that would collide with one already
    // at `to`, and the DELETE drops it, so the two merge.
    db.query(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE group_id = ? AND ${column} = ?`)
      .run(to, groupId, from);
    db.query(`DELETE FROM ${table} WHERE group_id = ? AND ${column} = ?`).run(groupId, from);
  }
  // A Relationship is authored, and both its ends were Notes when it was
  // recorded, so one at `to` is an orphan: clear it, like an own row.
  deleteRelationsOf(groupId, to);
  repointRelations(groupId, from, to);
  // users is not per World, so only this World's members follow.
  db.query(
    `UPDATE users SET active_character_path = ?
      WHERE active_character_path = ?
        AND id IN (SELECT user_id FROM group_members WHERE group_id = ?)`,
  ).run(to, from, groupId);
}

/** Before a link into `from` merges into the same link already into
 *  `to`, the surviving row takes the moving one's flags too: a manual
 *  link that lost its flag would vanish on the linker's next save. */
function keepLinkFlags(groupId: string, from: string, to: string): void {
  getDb()
    .query(
      `UPDATE note_links AS d
          SET is_manual = MAX(d.is_manual, s.is_manual), is_index = MAX(d.is_index, s.is_index)
         FROM note_links AS s
        WHERE d.group_id = ? AND d.to_path = ?
          AND s.group_id = d.group_id AND s.from_path = d.from_path AND s.to_path = ?`,
    )
    .run(groupId, to, from);
}

function nestedFolderRenames(groupId: string, folder: PathMove): Rename[] {
  return getDb()
    .query<{ path: string }, [string, string]>(
      `SELECT DISTINCT path FROM folder_markers WHERE group_id = ? AND path LIKE ? || '/%'`,
    )
    .all(groupId, folder.from)
    .map((mk) => ({ from: mk.path, to: folder.to + mk.path.slice(folder.from.length) }));
}

/** Folder markers and campaign rows under `folder.from` move under
 *  `folder.to`. A campaign's slug follows its folder name. */
function carryFolder(groupId: string, folder: PathMove): void {
  const db = getDb();
  const { from, to } = folder;
  const markers = db
    .query<{ path: string }, [string, string, string]>(
      `SELECT path FROM folder_markers WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    )
    .all(groupId, from, from);
  for (const mk of markers) {
    const next = to + mk.path.slice(from.length);
    db.query('DELETE FROM folder_markers WHERE group_id = ? AND path = ?').run(groupId, next);
    db.query('UPDATE folder_markers SET path = ? WHERE group_id = ? AND path = ?').run(next, groupId, mk.path);
  }

  const campaigns = db
    .query<{ slug: string; folder_path: string }, [string, string, string]>(
      `SELECT slug, folder_path FROM campaigns
        WHERE group_id = ? AND (folder_path = ? OR folder_path LIKE ? || '/%')`,
    )
    .all(groupId, from, from);
  for (const c of campaigns) {
    const nextPath = to + c.folder_path.slice(from.length);
    const nextSlug = slugify(nextPath.split('/').pop() ?? c.slug);
    db.query('DELETE FROM campaigns WHERE group_id = ? AND slug = ? AND slug != ?').run(groupId, nextSlug, c.slug);
    db.query('UPDATE campaigns SET folder_path = ?, slug = ? WHERE group_id = ? AND slug = ?')
      .run(nextPath, nextSlug, groupId, c.slug);
    if (nextSlug === c.slug) continue;
    db.query('UPDATE character_campaigns SET campaign_slug = ? WHERE group_id = ? AND campaign_slug = ?')
      .run(nextSlug, groupId, c.slug);
    db.query('UPDATE session_notes SET campaign_slug = ? WHERE group_id = ? AND campaign_slug = ?')
      .run(nextSlug, groupId, c.slug);
    // The World's pinned campaign would otherwise point at a slug that
    // no longer exists.
    db.query('UPDATE groups SET active_campaign_slug = ? WHERE id = ? AND active_campaign_slug = ?')
      .run(nextSlug, groupId, c.slug);
  }
}

/** A pending Wrap-up names Notes by path: the Session, existing-Note
 *  mentions, Relationship ends and Suggestion Characters. Each follows
 *  its Note, or the review would silently drop it as not found. */
function repointWrapUps(groupId: string, newPathOf: ReadonlyMap<string, string>): void {
  if (newPathOf.size === 0) return;
  const db = getDb();
  const rows = db
    .query<{ note_path: string; wrap_up_json: string }, [string]>(
      'SELECT note_path, wrap_up_json FROM session_notes WHERE group_id = ? AND wrap_up_json IS NOT NULL',
    )
    .all(groupId);
  for (const row of rows) {
    const next = repointProposalJson(row.wrap_up_json, newPathOf);
    if (next === null) continue;
    db.query('UPDATE session_notes SET wrap_up_json = ? WHERE group_id = ? AND note_path = ?')
      .run(next, groupId, row.note_path);
  }
}

type PathRef = { type?: unknown; path?: unknown };
type StoredProposal = {
  sessionPath?: unknown;
  mentions?: Array<{ match?: PathRef }>;
  relations?: Array<{ from?: PathRef; to?: PathRef }>;
  suggestions?: Array<{ characterPath?: unknown }>;
};

/** The proposal JSON with every path in `newPathOf` replaced, or null
 *  when nothing changed (or it does not parse, which the reader already
 *  treats as no proposal). Pure. */
export function repointProposalJson(json: string, newPathOf: ReadonlyMap<string, string>): string | null {
  let proposal: StoredProposal;
  try {
    proposal = JSON.parse(json) as StoredProposal;
  } catch {
    return null;
  }
  if (!proposal || typeof proposal !== 'object') return null;
  let changed = false;
  const remap = (path: unknown): unknown => {
    const next = typeof path === 'string' ? newPathOf.get(path) : undefined;
    if (next === undefined) return path;
    changed = true;
    return next;
  };
  const remapRef = (ref: PathRef | undefined): void => {
    if (ref && ref.type === 'existing') ref.path = remap(ref.path);
  };
  proposal.sessionPath = remap(proposal.sessionPath);
  for (const m of proposal.mentions ?? []) remapRef(m.match);
  for (const r of proposal.relations ?? []) {
    remapRef(r.from);
    remapRef(r.to);
  }
  for (const s of proposal.suggestions ?? []) s.characterPath = remap(s.characterPath);
  return changed ? JSON.stringify(proposal) : null;
}

// ── Copy ───────────────────────────────────────────────────────────────

/** Creates a Note at `to` from the Note at `from`: same body, Y.Doc
 *  state and frontmatter, a new id. Its outgoing links and tags come
 *  with it; incoming links, aliases and Relationships stay with the
 *  original, which they are about. Its indexes are derived and its
 *  folder index refreshed. `title`, `dmOnly` and `gmOnly` default to the
 *  original's. */
export async function copyNote(opts: {
  groupId: string;
  userId: string;
  from: string;
  to: string;
  title?: string;
  dmOnly?: boolean;
  gmOnly?: boolean;
  inTransaction?: () => void;
}): Promise<{ ok: true } | PathError> {
  const { groupId, userId, from, to } = opts;
  const db = getDb();
  let failed: PathError | null = null;
  try {
    db.transaction(() => {
      const src = db
        .query<
          { title: string; frontmatter_json: string; dm_only: number; gm_only: number },
          [string, string]
        >('SELECT title, frontmatter_json, dm_only, gm_only FROM notes WHERE group_id = ? AND path = ?')
        .get(groupId, from);
      if (!src) {
        failed = { ok: false, error: 'not_found', path: from };
        return;
      }
      const now = Date.now();
      db.query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                            yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                            created_at, created_by, dm_only, gm_only)
         SELECT ?, group_id, ?, ?, content_json, content_text, content_md,
                yjs_state, frontmatter_json, byte_size, ?, ?, ?, ?, ?, ?
           FROM notes WHERE group_id = ? AND path = ?`,
      ).run(
        randomUUID(),
        to,
        opts.title ?? src.title,
        now,
        userId,
        now,
        userId,
        flag(opts.dmOnly, src.dm_only),
        flag(opts.gmOnly, src.gm_only),
        groupId,
        from,
      );
      db.query(
        `INSERT OR IGNORE INTO note_links (group_id, from_path, to_path)
         SELECT group_id, ?, to_path FROM note_links
          WHERE group_id = ? AND from_path = ? AND to_path != ?`,
      ).run(to, groupId, from, to);
      db.query(
        `INSERT OR IGNORE INTO tags (group_id, path, tag)
         SELECT group_id, ?, tag FROM tags WHERE group_id = ? AND path = ?`,
      ).run(to, groupId, from);
      deriveAllIndexes({ groupId, notePath: to, frontmatterJson: src.frontmatter_json });
      opts.inTransaction?.();
    })();
  } catch (err) {
    // Only the notes INSERT can break a unique key (links and tags are
    // OR IGNORE): a concurrent writer took `to`.
    if (isUniqueConstraintError(err)) return { ok: false, error: 'exists', path: to };
    throw err;
  }
  if (failed) return failed;
  await afterCommit('folder index refresh', () => deriveFolderIndexesFor(groupId, [to], { userId }));
  return { ok: true };
}

function flag(wanted: boolean | undefined, source: number): number {
  return wanted === undefined ? source : wanted ? 1 : 0;
}

// ── Delete ─────────────────────────────────────────────────────────────

/** Deletes each Note in `paths` and every row that names it, then evicts
 *  its editors and refreshes the folder indexes it sat in. With `folder`,
 *  that folder's markers go too. Paths that do not exist are skipped.
 *
 *  Links into a deleted Note go with it, as do Suggestions naming it as
 *  Character or Session (a Note re-created at the path starts clean).
 *  A Relationship it established as a Session forgets it. */
export async function deleteNotes(opts: {
  groupId: string;
  userId: string;
  paths: readonly string[];
  folder?: string;
  inTransaction?: () => void;
}): Promise<void> {
  const { groupId, userId, paths, folder } = opts;
  const db = getDb();
  db.transaction(() => {
    db.exec('PRAGMA defer_foreign_keys = 1');
    for (const path of paths) {
      db.query('DELETE FROM note_links WHERE group_id = ? AND (from_path = ? OR to_path = ?)').run(groupId, path, path);
      db.query('DELETE FROM tags WHERE group_id = ? AND path = ?').run(groupId, path);
      db.query('DELETE FROM aliases WHERE group_id = ? AND path = ?').run(groupId, path);
      db.query('DELETE FROM character_suggestions WHERE group_id = ? AND (character_path = ? OR session_path = ?)')
        .run(groupId, path, path);
      deleteRelationsOf(groupId, path);
      db.query(
        `UPDATE users SET active_character_path = NULL
          WHERE active_character_path = ?
            AND id IN (SELECT user_id FROM group_members WHERE group_id = ?)`,
      ).run(path, groupId);
      // characters, character_campaigns, session_notes, items, locations
      // and creatures cascade from the notes row.
      db.query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(groupId, path);
    }
    if (folder) {
      db.query(`DELETE FROM folder_markers WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`)
        .run(groupId, folder, folder);
    }
    opts.inTransaction?.();
  })();

  await afterCommit('editor eviction', async () => {
    for (const path of paths) await closeDocumentConnections(groupId, path);
  });
  await afterCommit('folder index refresh', () =>
    deriveFolderIndexesFor(groupId, folder ? [folder, ...paths] : [...paths], {
      userId,
      createMissing: false,
    }),
  );
}

// ── Shared ─────────────────────────────────────────────────────────────

/** Runs work that follows a committed write. The write has landed, so a
 *  failure here is logged, never thrown at a caller that would report
 *  the whole operation as failed. */
async function afterCommit(what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`[note-paths] ${what} failed:`, err);
  }
}

function noteExists(groupId: string, path: string): boolean {
  return (
    getDb()
      .query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?')
      .get(groupId, path)?.n === 1
  );
}
