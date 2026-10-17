// Note read helpers. Small module that wraps the DB queries used by the
// notes / tree endpoints and the note page.

import { getDb } from './db';

/** Sanctioned top-level folder names. Every user-visible path must
 *  start with one of these — no free-form top-level organisation.
 *  Kept in sync with `DEFAULT_FOLDERS` / `isSystemFolder` in `./tree`. */
export const TOP_LEVEL_ALLOWED: ReadonlySet<string> = new Set([
  'Campaigns',
  'World Lore',
  'Assets',
  'Excalidraw',
]);

// Matching control characters is the point of this regex.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function hasControlChars(s: string): boolean {
  return CONTROL_CHARS.test(s);
}

/** Validate a folder or note path against the two invariants the UI
 *  relies on:
 *    - first segment must be a sanctioned top-level folder
 *    - no segment may start with "." (reserved for ephemeral docs)
 *
 *  Empty input is rejected — callers should never feed `""` in. */
export function isAllowedPath(
  path: string,
): { ok: true } | { ok: false; reason: string } {
  if (!path) return { ok: false, reason: 'empty_path' };
  if (hasControlChars(path)) {
    return { ok: false, reason: 'names cannot contain control characters' };
  }
  const normalised = path.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (!normalised) return { ok: false, reason: 'empty_path' };

  const segments = normalised.split('/');
  if (segments.length === 0) return { ok: false, reason: 'empty_path' };
  const first = segments[0]!;
  if (!TOP_LEVEL_ALLOWED.has(first)) {
    return {
      ok: false,
      reason: `top-level folder must be one of: ${[...TOP_LEVEL_ALLOWED].join(', ')}`,
    };
  }

  for (const seg of segments) {
    if (seg.startsWith('.')) {
      return { ok: false, reason: 'names cannot start with a dot' };
    }
  }

  return { ok: true };
}

export type NoteRow = {
  id: string;
  path: string;
  title: string;
  content_json: string;
  content_md: string;
  content_text: string;
  frontmatter_json: string;
  byte_size: number;
  updated_at: number;
  updated_by: string | null;
  created_at: number;
  created_by: string | null;
  dm_only: number;
  gm_only: number;
};

export type NoteAuthor = {
  userId: string;
  displayName: string;
  username: string;
};

export type BacklinkRow = {
  from_path: string;
  title: string;
  /** 1 = created via sidebar/graph UI; 0 = derived from [[wikilink]] in body */
  is_manual: number;
};

export type OutgoingLinkRow = {
  to_path: string;
  title: string;
  /** 1 = created via sidebar/graph UI; 0 = derived from [[wikilink]] in body */
  is_manual: number;
};

export type TagRow = {
  path: string;
  tag: string;
};

/** Visibility filter for the note read helpers. Mirrors the gates in
 *  `collab/server.ts`: viewers never see `dm_only` notes, non-admins
 *  never see `gm_only` notes. */
export type VisibilityOpts = { hideDmOnly?: boolean; hideGmOnly?: boolean };

/** A fully specified visibility predicate. List functions take this
 *  rather than `VisibilityOpts` so a caller can't pass `{}` and get
 *  every hidden note back. */
export type Visibility = { hideDmOnly: boolean; hideGmOnly: boolean };

type MemberRole = 'admin' | 'editor' | 'viewer';
const MEMBER_ROLES: readonly MemberRole[] = ['admin', 'editor', 'viewer'];

/** The canonical role → visibility mapping. Every REST / RSC read path
 *  derives its filter here rather than re-deriving the comparison. */
export function visibilityFor(role: MemberRole): Visibility {
  return { hideDmOnly: role === 'viewer', hideGmOnly: role !== 'admin' };
}

/** ` AND <alias>.dm_only = 0 AND <alias>.gm_only = 0`, or the parts of
 *  it `vis` asks for. Appended to a WHERE clause over `notes <alias>`. */
function hiddenNotesSql(alias: string, vis: Visibility): string {
  return (
    (vis.hideDmOnly ? ` AND ${alias}.dm_only = 0` : '') +
    (vis.hideGmOnly ? ` AND ${alias}.gm_only = 0` : '')
  );
}

/** SQL predicate: note `<n>` is visible to the member row `<m>` under
 *  that member's own role. Built from `visibilityFor` so the mapping
 *  stays in one place; a role outside MEMBER_ROLES matches nothing. */
function visibleToMemberSql(n: string, m: string): string {
  return MEMBER_ROLES.map(
    (role) => `(${m}.role = '${role}'${hiddenNotesSql(n, visibilityFor(role))})`,
  ).join(' OR ');
}

/** Inputs to `canWriteAllSheetFields` — deliberately plain data, no DB
 *  row or session object, so the decision is unit-testable without a
 *  request/session fixture. */
export type SheetWriteContext = {
  sessionRole: 'admin' | 'editor' | 'viewer';
  sessionUserId: string;
  sessionUsername: string;
  /** `created_by` column of the note being patched. */
  noteCreatedBy: string | null;
  /** Character role inferred for the note (`pc` / `npc` / `ally` /
   *  `villain`), or `null` for non-character kinds (item, location, …). */
  characterRole: string | null;
  /** Raw `frontmatter.player` value — may be missing/non-string. */
  fmPlayer: unknown;
};

/** Full-sheet write eligibility for `PATCH /api/notes/sheet`.
 *
 *  Mirrors the documented permission model:
 *    - admin / editor          — may write any field
 *    - creator of the note     — may write any field (regardless of role)
 *    - PC owner (player match) — may write any field on their PC
 *    - anyone else             — playerEditable fields only (checked by
 *                                the caller, not here)
 *
 *  Deliberately does NOT consider "who last wrote this row"
 *  (`updated_by`) — that column is overwritten by every PATCH,
 *  including this route's own previous call, so using it as a
 *  capability check lets any player who makes one permitted
 *  `playerEditable` edit silently escalate to full-sheet write on
 *  their next PATCH. */
export function canWriteAllSheetFields(ctx: SheetWriteContext): boolean {
  if (ctx.sessionRole === 'admin' || ctx.sessionRole === 'editor') return true;
  if (ctx.noteCreatedBy !== null && ctx.noteCreatedBy === ctx.sessionUserId) return true;
  if (
    ctx.characterRole === 'pc' &&
    typeof ctx.fmPlayer === 'string' &&
    ctx.fmPlayer.trim().toLowerCase() === ctx.sessionUsername.trim().toLowerCase()
  ) {
    return true;
  }
  return false;
}

export function loadNote(groupId: string, path: string): NoteRow | null {
  return (
    getDb()
      .query<NoteRow, [string, string]>(
        `SELECT id, path, title, content_json, content_md, content_text,
                frontmatter_json, byte_size, updated_at, updated_by,
                created_at, created_by, dm_only, gm_only
           FROM notes WHERE group_id = ? AND path = ?`,
      )
      .get(groupId, path) ?? null
  );
}

/** Nearest ancestor folder — starting at `folderPath` itself and
 *  walking up toward the root — that has an `index.md` note. Used to
 *  pick a sensible redirect target after a note or folder delete:
 *  landing back on the containing folder's page (which the user was
 *  presumably already working in) reads better than always bouncing
 *  to the dashboard, and it's a real page rather than a guess (unlike
 *  building `/notes/<first path segment>`, which 404s for anything
 *  under `Campaigns/<slug>/…` — there's no note at bare `Campaigns`).
 *  Returns null when no ancestor has an index — true for content
 *  directly under `Assets` or `Excalidraw`, which never get one (see
 *  `index-notes.ts`) — so the caller falls back to the dashboard. */
export function findNearestIndexPath(
  groupId: string,
  folderPath: string,
): string | null {
  const db = getDb();
  let folder = folderPath;
  while (folder) {
    const indexPath = `${folder}/index.md`;
    const row = db
      .query<{ path: string }, [string, string]>(
        'SELECT path FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, indexPath);
    if (row) return row.path;
    const slash = folder.lastIndexOf('/');
    if (slash < 0) break;
    folder = folder.slice(0, slash);
  }
  return null;
}

export function loadUser(userId: string): NoteAuthor | null {
  return (
    getDb()
      .query<NoteAuthor, [string]>(
        `SELECT id AS userId, display_name AS displayName, username
           FROM users WHERE id = ?`,
      )
      .get(userId) ?? null
  );
}

export function loadBacklinks(
  groupId: string,
  path: string,
  opts: VisibilityOpts,
): BacklinkRow[] {
  // LEFT JOIN — `IS NULL` means the source note row is gone (a dangling
  // note_links entry). Those stay visible; the panel falls back to
  // rendering the raw from_path.
  const dmFilter = opts.hideDmOnly
    ? ' AND (n.dm_only IS NULL OR n.dm_only = 0)'
    : '';
  const gmFilter = opts.hideGmOnly
    ? ' AND (n.gm_only IS NULL OR n.gm_only = 0)'
    : '';
  return getDb()
    .query<BacklinkRow, [string, string]>(
      `SELECT nl.from_path AS from_path,
              COALESCE(n.title, nl.from_path) AS title,
              nl.is_manual AS is_manual
         FROM note_links nl
         LEFT JOIN notes n ON n.group_id = nl.group_id AND n.path = nl.from_path
        WHERE nl.group_id = ? AND nl.to_path = ?${dmFilter}${gmFilter}
        ORDER BY nl.from_path`,
    )
    .all(groupId, path);
}

export function loadOutgoingLinks(
  groupId: string,
  fromPath: string,
  opts: VisibilityOpts,
): OutgoingLinkRow[] {
  // INNER JOIN — the target note always exists here, so no IS NULL
  // disjunct (unlike loadBacklinks).
  const dmFilter = opts.hideDmOnly ? ' AND n.dm_only = 0' : '';
  const gmFilter = opts.hideGmOnly ? ' AND n.gm_only = 0' : '';
  return getDb()
    .query<OutgoingLinkRow, [string, string]>(
      // INNER JOIN so only links where the target note actually exists are
      // returned — dangling references and __orphan__: wikilinks (written to
      // note_links when the target doesn't exist yet) are omitted because the
      // graph can't draw an edge to a non-existent node either, and the ugly
      // "__orphan__:..." path string is meaningless to the reader.
      `SELECT nl.to_path AS to_path,
              COALESCE(n.title, nl.to_path) AS title,
              nl.is_manual AS is_manual
         FROM note_links nl
         JOIN notes n ON n.group_id = nl.group_id AND n.path = nl.to_path
        WHERE nl.group_id = ? AND nl.from_path = ?
          AND nl.to_path NOT LIKE '__orphan__%'${dmFilter}${gmFilter}
        ORDER BY nl.to_path`,
    )
    .all(groupId, fromPath);
}

export function loadTags(groupId: string, path: string): string[] {
  return getDb()
    .query<{ tag: string }, [string, string]>(
      `SELECT tag FROM tags WHERE group_id = ? AND path = ? ORDER BY tag`,
    )
    .all(groupId, path)
    .map((r) => r.tag);
}

/** Every tag on a note `vis` lets the caller see, with how many such
 *  notes carry it. A tag that only hidden notes carry is not listed. */
export function listAllTags(
  groupId: string,
  vis: Visibility,
): Array<{ tag: string; count: number }> {
  return getDb()
    .query<{ tag: string; count: number }, [string]>(
      `SELECT t.tag AS tag, COUNT(*) AS count
         FROM tags t
         JOIN notes n ON n.group_id = t.group_id AND n.path = t.path
        WHERE t.group_id = ?${hiddenNotesSql('n', vis)}
        GROUP BY t.tag
        ORDER BY count DESC, t.tag ASC`,
    )
    .all(groupId);
}

export function listNotesByTag(
  groupId: string,
  tag: string,
  vis: Visibility,
): Array<{ path: string; title: string; updatedAt: number }> {
  return getDb()
    .query<
      { path: string; title: string; updatedAt: number },
      [string, string]
    >(
      `SELECT n.path AS path, n.title AS title, n.updated_at AS updatedAt
         FROM tags t
         JOIN notes n ON n.group_id = t.group_id AND n.path = t.path
        WHERE t.group_id = ? AND t.tag = ?${hiddenNotesSql('n', vis)}
        ORDER BY n.title COLLATE NOCASE ASC`,
    )
    .all(groupId, tag);
}

/** Number of notes in the World `vis` lets the caller see. */
export function countVisibleNotes(groupId: string, vis: Visibility): number {
  return (
    getDb()
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM notes n
          WHERE n.group_id = ?${hiddenNotesSql('n', vis)}`,
      )
      .get(groupId)?.n ?? 0
  );
}

export function listAllPaths(groupId: string): Array<{ path: string; title: string; updatedAt: number }> {
  return getDb()
    .query<
      { path: string; title: string; updatedAt: number },
      [string]
    >(`SELECT path, title, updated_at AS updatedAt FROM notes WHERE group_id = ? ORDER BY path`)
    .all(groupId);
}

export function recentlyUpdated(
  groupId: string,
  limit: number,
  vis: Visibility,
): Array<{ path: string; title: string; updatedAt: number }> {
  return getDb()
    .query<
      { path: string; title: string; updatedAt: number },
      [string, number]
    >(
      `SELECT n.path AS path, n.title AS title, n.updated_at AS updatedAt
         FROM notes n
        WHERE n.group_id = ?${hiddenNotesSql('n', vis)}
        ORDER BY n.updated_at DESC LIMIT ?`,
    )
    .all(groupId, Math.max(1, Math.min(limit, 200)));
}

export type RecentForUserRow = {
  groupId: string;
  groupName: string;
  path: string;
  title: string;
  updatedAt: number;
};

/** Recently updated notes across every world the user is a member of.
 *  Used on the personal overview (`/me`) to surface what the user was
 *  last touching regardless of which world it lived in. Each World's
 *  notes are filtered by the user's role in that World. */
export function listRecentForUser(userId: string, limit: number): RecentForUserRow[] {
  return getDb()
    .query<RecentForUserRow, [string, number]>(
      `SELECT n.group_id AS groupId,
              g.name     AS groupName,
              n.path     AS path,
              n.title    AS title,
              n.updated_at AS updatedAt
         FROM notes n
         JOIN group_members gm ON gm.group_id = n.group_id
         JOIN groups g         ON g.id = n.group_id
        WHERE gm.user_id = ?
          AND (${visibleToMemberSql('n', 'gm')})
        ORDER BY n.updated_at DESC
        LIMIT ?`,
    )
    .all(userId, Math.max(1, Math.min(limit, 100)));
}

/** Decode a Next `[...path]` catch-all segment array into a canonical
 *  forward-slash path string, rejecting `..`/null bytes/drive letters. */
export function decodePath(segments: string[]): string | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const parts: string[] = [];
  for (const raw of segments) {
    let dec: string;
    try {
      dec = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (dec.includes('\0') || dec === '..' || dec === '.') return null;
    if (/[\\:]/.test(dec)) return null;
    parts.push(dec);
  }
  return parts.join('/');
}
