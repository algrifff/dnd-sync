// Note read helpers. Small module that wraps the DB queries used by the
// notes / backlinks / preview / tree endpoints and the note page.

import { getDb } from './db';

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
};

export type NoteAuthor = {
  userId: string;
  displayName: string;
  username: string;
};

export type NotePreview = {
  path: string;
  title: string;
  excerpt: string;
};

export type BacklinkRow = {
  from_path: string;
  title: string;
};

export type TagRow = {
  path: string;
  tag: string;
};

export function loadNote(groupId: string, path: string): NoteRow | null {
  return (
    getDb()
      .query<NoteRow, [string, string]>(
        `SELECT id, path, title, content_json, content_md, content_text,
                frontmatter_json, byte_size, updated_at, updated_by,
                created_at, created_by, dm_only
           FROM notes WHERE group_id = ? AND path = ?`,
      )
      .get(groupId, path) ?? null
  );
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

export function loadPreview(groupId: string, path: string): NotePreview | null {
  const row = getDb()
    .query<{ title: string; content_text: string }, [string, string]>(
      `SELECT title, content_text FROM notes WHERE group_id = ? AND path = ?`,
    )
    .get(groupId, path);
  if (!row) return null;
  const excerpt = row.content_text.slice(0, 240).trim();
  return { path, title: row.title, excerpt };
}

export function loadBacklinks(
  groupId: string,
  path: string,
  opts?: { hideDmOnly?: boolean },
): BacklinkRow[] {
  const dmFilter = opts?.hideDmOnly
    ? ' AND (n.dm_only IS NULL OR n.dm_only = 0)'
    : '';
  return getDb()
    .query<BacklinkRow, [string, string]>(
      `SELECT nl.from_path AS from_path, COALESCE(n.title, nl.from_path) AS title
         FROM note_links nl
         LEFT JOIN notes n ON n.group_id = nl.group_id AND n.path = nl.from_path
        WHERE nl.group_id = ? AND nl.to_path = ?${dmFilter}
        ORDER BY nl.from_path`,
    )
    .all(groupId, path);
}

export function loadTags(groupId: string, path: string): string[] {
  return getDb()
    .query<{ tag: string }, [string, string]>(
      `SELECT tag FROM tags WHERE group_id = ? AND path = ? ORDER BY tag`,
    )
    .all(groupId, path)
    .map((r) => r.tag);
}

export function listAllTags(groupId: string): Array<{ tag: string; count: number }> {
  return getDb()
    .query<{ tag: string; count: number }, [string]>(
      `SELECT tag, COUNT(*) AS count
         FROM tags WHERE group_id = ?
         GROUP BY tag
         ORDER BY count DESC, tag ASC`,
    )
    .all(groupId);
}

export function listNotesByTag(
  groupId: string,
  tag: string,
): Array<{ path: string; title: string; updatedAt: number }> {
  return getDb()
    .query<
      { path: string; title: string; updatedAt: number },
      [string, string]
    >(
      `SELECT n.path AS path, n.title AS title, n.updated_at AS updatedAt
         FROM tags t
         JOIN notes n ON n.group_id = t.group_id AND n.path = t.path
        WHERE t.group_id = ? AND t.tag = ?
        ORDER BY n.title COLLATE NOCASE ASC`,
    )
    .all(groupId, tag);
}

export function listAllPaths(groupId: string): Array<{ path: string; title: string; updatedAt: number }> {
  return getDb()
    .query<
      { path: string; title: string; updatedAt: number },
      [string]
    >(`SELECT path, title, updated_at AS updatedAt FROM notes WHERE group_id = ? ORDER BY path`)
    .all(groupId);
}

export function recentlyUpdated(groupId: string, limit: number): Array<{ path: string; title: string; updatedAt: number }> {
  return getDb()
    .query<
      { path: string; title: string; updatedAt: number },
      [string, number]
    >(
      `SELECT path, title, updated_at AS updatedAt
         FROM notes WHERE group_id = ?
         ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(groupId, Math.max(1, Math.min(limit, 200)));
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
