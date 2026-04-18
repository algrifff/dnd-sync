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
                frontmatter_json, byte_size, updated_at, updated_by
           FROM notes WHERE group_id = ? AND path = ?`,
      )
      .get(groupId, path) ?? null
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

export function loadBacklinks(groupId: string, path: string): BacklinkRow[] {
  return getDb()
    .query<BacklinkRow, [string, string]>(
      `SELECT nl.from_path AS from_path, COALESCE(n.title, nl.from_path) AS title
         FROM note_links nl
         LEFT JOIN notes n ON n.group_id = nl.group_id AND n.path = nl.from_path
        WHERE nl.group_id = ? AND nl.to_path = ?
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
