import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import {
  canWriteAllSheetFields,
  decodePath,
  findNearestIndexPath,
  loadBacklinks,
  loadNote,
  loadOutgoingLinks,
  loadPreview,
  loadTags,
  visibilityFor,
} from './notes';
import { setupTestDb, teardownTestDb } from './test-utils';
import { DEFAULT_GROUP_ID } from './users';

// ── Test helpers ───────────────────────────────────────────────────────

function seedGroup(id: string, name = id): void {
  getDb()
    .query(
      `INSERT OR IGNORE INTO groups (id, name, created_at) VALUES (?, ?, ?)`,
    )
    .run(id, name, Date.now());
}

function seedNote(groupId: string, path: string): string {
  const id = randomUUID();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, content_json, updated_at)
       VALUES (?, ?, ?, '{}', ?)`,
    )
    .run(id, groupId, path, Date.now());
  return id;
}

function seedNoteWithFlags(
  groupId: string,
  path: string,
  flags: { dmOnly?: boolean; gmOnly?: boolean },
): string {
  const id = randomUUID();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, content_json, content_text,
                          title, updated_at, dm_only, gm_only)
       VALUES (?, ?, ?, '{}', 'secret body', 'Secret', ?, ?, ?)`,
    )
    .run(id, groupId, path, Date.now(), flags.dmOnly ? 1 : 0, flags.gmOnly ? 1 : 0);
  return id;
}

function seedTag(groupId: string, path: string, tag: string): void {
  getDb()
    .query(`INSERT INTO tags (group_id, path, tag) VALUES (?, ?, ?)`)
    .run(groupId, path, tag);
}

function seedLink(groupId: string, fromPath: string, toPath: string): void {
  getDb()
    .query(`INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)`)
    .run(groupId, fromPath, toPath);
}

function seedAlias(groupId: string, path: string, alias: string): void {
  getDb()
    .query(`INSERT INTO aliases (group_id, path, alias) VALUES (?, ?, ?)`)
    .run(groupId, path, alias);
}

function countLinks(groupId: string, path: string): number {
  const row = getDb()
    .query<{ n: number }, [string, string, string]>(
      `SELECT COUNT(*) AS n FROM note_links
        WHERE group_id = ? AND (from_path = ? OR to_path = ?)`,
    )
    .get(groupId, path, path);
  return row?.n ?? 0;
}

function countAliases(groupId: string, path: string): number {
  const row = getDb()
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM aliases WHERE group_id = ? AND path = ?`,
    )
    .get(groupId, path);
  return row?.n ?? 0;
}

// ── DB setup ───────────────────────────────────────────────────────────

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM note_links');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM aliases');
  db.exec('DELETE FROM notes');
});

// ── decodePath ─────────────────────────────────────────────────────────

describe('decodePath', () => {
  it('joins segments with forward slashes', () => {
    expect(decodePath(['a', 'b', 'c.md'])).toBe('a/b/c.md');
  });

  it('handles a single segment', () => {
    expect(decodePath(['note.md'])).toBe('note.md');
  });

  it('decodes percent-encoded characters', () => {
    expect(decodePath(['my%20note.md'])).toBe('my note.md');
  });

  it('returns null for an empty array', () => {
    expect(decodePath([])).toBeNull();
  });

  it('returns null for a .. traversal segment', () => {
    expect(decodePath(['..'])).toBeNull();
    expect(decodePath(['a', '..', 'b'])).toBeNull();
  });

  it('returns null for a . current-dir segment', () => {
    expect(decodePath(['.', 'note.md'])).toBeNull();
  });

  it('returns null for a segment containing a null byte', () => {
    expect(decodePath(['note\x00.md'])).toBeNull();
  });

  it('returns null for a segment containing a backslash', () => {
    expect(decodePath(['a\\b.md'])).toBeNull();
  });

  it('returns null for a segment containing a colon (drive letter)', () => {
    expect(decodePath(['C:note.md'])).toBeNull();
  });

  it('returns null for malformed percent encoding', () => {
    expect(decodePath(['%ZZ'])).toBeNull();
  });
});

// ── loadNote / multi-tenancy ───────────────────────────────────────────

describe('loadNote — multi-tenancy', () => {
  const path = 'vault/secret.md';

  it('returns a note when queried with the correct group', () => {
    seedNote(DEFAULT_GROUP_ID, path);
    expect(loadNote(DEFAULT_GROUP_ID, path)).not.toBeNull();
  });

  it('returns null when a different group id is used', () => {
    const otherGroup = 'group-other-' + randomUUID().slice(0, 8);
    seedGroup(otherGroup);
    seedNote(DEFAULT_GROUP_ID, path);
    expect(loadNote(otherGroup, path)).toBeNull();
  });

  it('returns null for a path that does not exist', () => {
    expect(loadNote(DEFAULT_GROUP_ID, 'does-not-exist.md')).toBeNull();
  });
});

// ── cascade delete ─────────────────────────────────────────────────────

describe('cascade delete', () => {
  const target = 'notes/target.md';
  const other = 'notes/other.md';

  function performCascadeDelete(groupId: string, path: string): void {
    const db = getDb();
    db.transaction(() => {
      db.query(
        `DELETE FROM note_links WHERE group_id = ? AND (from_path = ? OR to_path = ?)`,
      ).run(groupId, path, path);
      db.query(`DELETE FROM tags WHERE group_id = ? AND path = ?`).run(groupId, path);
      db.query(`DELETE FROM aliases WHERE group_id = ? AND path = ?`).run(groupId, path);
      db.query(`DELETE FROM notes WHERE group_id = ? AND path = ?`).run(groupId, path);
    })();
  }

  beforeEach(() => {
    seedNote(DEFAULT_GROUP_ID, target);
    seedNote(DEFAULT_GROUP_ID, other);
    seedTag(DEFAULT_GROUP_ID, target, 'adventure');
    seedTag(DEFAULT_GROUP_ID, target, 'lore');
    seedLink(DEFAULT_GROUP_ID, other, target); // incoming link to target
    seedLink(DEFAULT_GROUP_ID, target, other); // outgoing link from target
    seedAlias(DEFAULT_GROUP_ID, target, 'the-target');
  });

  it('removes the note row', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(loadNote(DEFAULT_GROUP_ID, target)).toBeNull();
  });

  it('removes all tags for the deleted note', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(loadTags(DEFAULT_GROUP_ID, target)).toHaveLength(0);
  });

  it('removes all note_links involving the deleted note (both directions)', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(countLinks(DEFAULT_GROUP_ID, target)).toBe(0);
  });

  it('removes all aliases for the deleted note', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(countAliases(DEFAULT_GROUP_ID, target)).toBe(0);
  });

  it('does not affect the other note', () => {
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(loadNote(DEFAULT_GROUP_ID, other)).not.toBeNull();
  });

  it('leaves tags on other notes intact', () => {
    seedTag(DEFAULT_GROUP_ID, other, 'unrelated');
    performCascadeDelete(DEFAULT_GROUP_ID, target);
    expect(loadTags(DEFAULT_GROUP_ID, other)).toEqual(['unrelated']);
  });
});

// ── visibilityFor — the canonical role → visibility predicate ──────────
//
// This is the single point where a future regression would silently
// reopen every dm_only/gm_only leak at once — see the audit brief.

describe('visibilityFor', () => {
  it('hides both dm_only and gm_only notes from viewers', () => {
    expect(visibilityFor('viewer')).toEqual({ hideDmOnly: true, hideGmOnly: true });
  });

  it('shows dm_only but hides gm_only notes from editors', () => {
    // The admin-vs-editor distinction — the one that already caused a bug.
    expect(visibilityFor('editor')).toEqual({ hideDmOnly: false, hideGmOnly: true });
  });

  it('hides neither flag from admins', () => {
    expect(visibilityFor('admin')).toEqual({ hideDmOnly: false, hideGmOnly: false });
  });
});

// ── canWriteAllSheetFields ───────────────────────────────────────────────

describe('canWriteAllSheetFields', () => {
  const base = {
    sessionRole: 'viewer' as const,
    sessionUserId: 'user-1',
    sessionUsername: 'alice',
    noteCreatedBy: 'user-2',
    characterRole: 'pc' as string | null,
    fmPlayer: 'bob' as unknown,
  };

  it('grants full write to admins regardless of ownership', () => {
    expect(canWriteAllSheetFields({ ...base, sessionRole: 'admin' })).toBe(true);
  });

  it('grants full write to editors regardless of ownership', () => {
    expect(canWriteAllSheetFields({ ...base, sessionRole: 'editor' })).toBe(true);
  });

  it('grants full write to the note creator', () => {
    expect(
      canWriteAllSheetFields({ ...base, noteCreatedBy: 'user-1', fmPlayer: 'someone-else' }),
    ).toBe(true);
  });

  it('grants full write to the matched PC owner (case/whitespace-insensitive)', () => {
    expect(
      canWriteAllSheetFields({ ...base, noteCreatedBy: 'user-2', fmPlayer: '  Alice  ' }),
    ).toBe(true);
  });

  it('does NOT grant full write to the last editor of the note', () => {
    // Regression guard for the privilege-escalation bug: a player who
    // made one permitted `playerEditable` edit becomes `updated_by` on
    // the row, but that must never imply full-sheet write on their next
    // PATCH. `updated_by` isn't even part of the input shape any more —
    // this test documents that "last editor" is not a grant path.
    expect(
      canWriteAllSheetFields({
        ...base,
        noteCreatedBy: 'user-2',
        fmPlayer: 'bob',
      }),
    ).toBe(false);
  });

  it('denies an unrelated player with no creator or ownership match', () => {
    expect(
      canWriteAllSheetFields({ ...base, noteCreatedBy: 'gm-user', fmPlayer: 'someone-else' }),
    ).toBe(false);
  });

  it('does not grant PC-owner write on non-pc character roles (npc/ally/villain)', () => {
    expect(
      canWriteAllSheetFields({
        ...base,
        noteCreatedBy: 'gm-user',
        characterRole: 'npc',
        fmPlayer: 'alice',
      }),
    ).toBe(false);
  });

  it('denies when fmPlayer is not a string (missing/undefined frontmatter.player)', () => {
    expect(
      canWriteAllSheetFields({ ...base, noteCreatedBy: 'gm-user', fmPlayer: undefined }),
    ).toBe(false);
  });

  it('denies a null noteCreatedBy from matching a null-ish sessionUserId comparison', () => {
    expect(
      canWriteAllSheetFields({
        ...base,
        noteCreatedBy: null,
        fmPlayer: 'someone-else',
      }),
    ).toBe(false);
  });
});

// ── loadPreview — visibility filtering ──────────────────────────────────

describe('loadPreview — visibility filtering', () => {
  const dmPath = 'vault/dm-secret.md';
  const gmPath = 'vault/gm-secret.md';
  const plainPath = 'vault/plain.md';

  beforeEach(() => {
    seedNoteWithFlags(DEFAULT_GROUP_ID, dmPath, { dmOnly: true });
    seedNoteWithFlags(DEFAULT_GROUP_ID, gmPath, { gmOnly: true });
    seedNoteWithFlags(DEFAULT_GROUP_ID, plainPath, {});
  });

  // `opts` used to be optional and default to "no filtering" — the exact
  // footgun that caused the backlinks leak (see loadBacklinks history).
  // `VisibilityOpts` is now a required parameter, so TypeScript itself
  // rejects any call site that forgets it; there is no runtime "no opts"
  // path left to test. See notes.ts#VisibilityOpts.

  it('returns null for a dm_only note when hideDmOnly is set', () => {
    expect(loadPreview(DEFAULT_GROUP_ID, dmPath, { hideDmOnly: true })).toBeNull();
  });

  it('still returns a dm_only note when only hideGmOnly is set', () => {
    expect(loadPreview(DEFAULT_GROUP_ID, dmPath, { hideGmOnly: true })).not.toBeNull();
  });

  it('returns null for a gm_only note when hideGmOnly is set', () => {
    expect(loadPreview(DEFAULT_GROUP_ID, gmPath, { hideGmOnly: true })).toBeNull();
  });

  it('still returns a gm_only note when only hideDmOnly is set', () => {
    expect(loadPreview(DEFAULT_GROUP_ID, gmPath, { hideDmOnly: true })).not.toBeNull();
  });

  it('does not lock out a plain note under a full viewer filter', () => {
    const vis = visibilityFor('viewer');
    expect(loadPreview(DEFAULT_GROUP_ID, plainPath, vis)).not.toBeNull();
  });
});

// ── loadBacklinks — visibility filtering ────────────────────────────────

describe('loadBacklinks — visibility filtering', () => {
  const targetPath = 'vault/target.md';
  const plainSource = 'vault/source-plain.md';
  const dmSource = 'vault/source-dm.md';
  const gmSource = 'vault/source-gm.md';

  beforeEach(() => {
    seedNoteWithFlags(DEFAULT_GROUP_ID, targetPath, {});
    seedNoteWithFlags(DEFAULT_GROUP_ID, plainSource, {});
    seedNoteWithFlags(DEFAULT_GROUP_ID, dmSource, { dmOnly: true });
    seedNoteWithFlags(DEFAULT_GROUP_ID, gmSource, { gmOnly: true });
    seedLink(DEFAULT_GROUP_ID, plainSource, targetPath);
    seedLink(DEFAULT_GROUP_ID, dmSource, targetPath);
    seedLink(DEFAULT_GROUP_ID, gmSource, targetPath);
  });

  it('yields only the plain source for a viewer', () => {
    const rows = loadBacklinks(DEFAULT_GROUP_ID, targetPath, visibilityFor('viewer'));
    expect(rows.map((r) => r.from_path)).toEqual([plainSource]);
  });

  it('yields plain + dm sources for an editor', () => {
    const rows = loadBacklinks(DEFAULT_GROUP_ID, targetPath, visibilityFor('editor'));
    expect(rows.map((r) => r.from_path).sort()).toEqual([dmSource, plainSource].sort());
  });

  it('yields all three sources for an admin', () => {
    const rows = loadBacklinks(DEFAULT_GROUP_ID, targetPath, visibilityFor('admin'));
    expect(rows.map((r) => r.from_path).sort()).toEqual(
      [dmSource, gmSource, plainSource].sort(),
    );
  });

  it('keeps a dangling backlink (no source note row) visible to a viewer', () => {
    // Regression guard: the `IS NULL` disjunct in the dm filter. A
    // "tightened" `n.dm_only = 0` would silently drop this row instead.
    seedLink(DEFAULT_GROUP_ID, '__deleted-source__.md', targetPath);
    const rows = loadBacklinks(DEFAULT_GROUP_ID, targetPath, visibilityFor('viewer'));
    expect(rows.map((r) => r.from_path)).toContain('__deleted-source__.md');
  });
});

// ── loadOutgoingLinks — visibility filtering ────────────────────────────

describe('loadOutgoingLinks — visibility filtering', () => {
  const fromPath = 'vault/source.md';
  const plainTarget = 'vault/target-plain.md';
  const dmTarget = 'vault/target-dm.md';
  const gmTarget = 'vault/target-gm.md';

  beforeEach(() => {
    seedNoteWithFlags(DEFAULT_GROUP_ID, fromPath, {});
    seedNoteWithFlags(DEFAULT_GROUP_ID, plainTarget, {});
    seedNoteWithFlags(DEFAULT_GROUP_ID, dmTarget, { dmOnly: true });
    seedNoteWithFlags(DEFAULT_GROUP_ID, gmTarget, { gmOnly: true });
    seedLink(DEFAULT_GROUP_ID, fromPath, plainTarget);
    seedLink(DEFAULT_GROUP_ID, fromPath, dmTarget);
    seedLink(DEFAULT_GROUP_ID, fromPath, gmTarget);
  });

  it('yields only the plain target for a viewer', () => {
    const rows = loadOutgoingLinks(DEFAULT_GROUP_ID, fromPath, visibilityFor('viewer'));
    expect(rows.map((r) => r.to_path)).toEqual([plainTarget]);
  });

  it('yields plain + dm targets for an editor', () => {
    const rows = loadOutgoingLinks(DEFAULT_GROUP_ID, fromPath, visibilityFor('editor'));
    expect(rows.map((r) => r.to_path).sort()).toEqual([dmTarget, plainTarget].sort());
  });

  it('yields all three targets for an admin', () => {
    const rows = loadOutgoingLinks(DEFAULT_GROUP_ID, fromPath, visibilityFor('admin'));
    expect(rows.map((r) => r.to_path).sort()).toEqual(
      [dmTarget, gmTarget, plainTarget].sort(),
    );
  });

  it('drops a dangling target (INNER JOIN, by design — not a LEFT JOIN)', () => {
    seedLink(DEFAULT_GROUP_ID, fromPath, '__deleted-target__.md');
    const rows = loadOutgoingLinks(DEFAULT_GROUP_ID, fromPath, visibilityFor('admin'));
    expect(rows.map((r) => r.to_path)).not.toContain('__deleted-target__.md');
  });
});

// ── findNearestIndexPath ─────────────────────────────────────────────────
// Drives the post-delete redirect target: the note/folder delete routes
// walk up from the deleted item's parent looking for a surviving
// index.md, so a displaced viewer lands on a real page instead of a
// guessed one.

describe('findNearestIndexPath', () => {
  it('returns the immediate folder index when it exists', () => {
    seedNote(DEFAULT_GROUP_ID, 'Campaigns/Foo/Characters/index.md');
    expect(
      findNearestIndexPath(DEFAULT_GROUP_ID, 'Campaigns/Foo/Characters'),
    ).toBe('Campaigns/Foo/Characters/index.md');
  });

  it('walks up to an ancestor index when the immediate folder has none', () => {
    seedNote(DEFAULT_GROUP_ID, 'Campaigns/Foo/index.md');
    // Campaigns/Foo/Characters/index.md deliberately not seeded.
    expect(
      findNearestIndexPath(DEFAULT_GROUP_ID, 'Campaigns/Foo/Characters'),
    ).toBe('Campaigns/Foo/index.md');
  });

  it('returns null when no ancestor has an index (e.g. Excalidraw)', () => {
    expect(findNearestIndexPath(DEFAULT_GROUP_ID, 'Excalidraw')).toBeNull();
  });

  it('does not cross into a different group', () => {
    seedGroup('other-group-for-index-test');
    seedNote('other-group-for-index-test', 'Campaigns/Foo/index.md');
    expect(findNearestIndexPath(DEFAULT_GROUP_ID, 'Campaigns/Foo')).toBeNull();
  });

  it('re-queries live state — a just-deleted index is not returned', () => {
    const id = seedNote(DEFAULT_GROUP_ID, 'Campaigns/Foo/index.md');
    getDb().query('DELETE FROM notes WHERE id = ?').run(id);
    expect(findNearestIndexPath(DEFAULT_GROUP_ID, 'Campaigns/Foo')).toBeNull();
  });
});
