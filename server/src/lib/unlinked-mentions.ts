// Unlinked mentions: Notes whose text names this Note's title or an alias
// as a whole word without linking to it (docs/adr/0003-connections-panel-
// and-manual-relationships.md). Read only; "Link" in the panel adds the
// plain manual link and never edits anyone's text.

import { getDb } from '@/lib/db';
import { hiddenNotesSql, visibilityFor } from '@/lib/notes';
import { worldFtsMatch } from '@/lib/search';
import type { Role } from '@/lib/wrap-up';

export type UnlinkedMention = { path: string; title: string; snippet: string };

const MIN_TERM_LENGTH = 4;
/** Candidate Notes read per term. FTS is looser than a whole-word match,
 *  so some are dropped; this bounds the work for a very common name. */
const CANDIDATES_PER_TERM = 200;
const SNIPPET_RADIUS = 40;

type Candidate = { path: string; title: string; content_text: string; updated_at: number };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole word, any case: not flanked by a letter, digit or underscore. */
function wholeWord(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'iu');
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '');
}

export function findUnlinkedMentions(opts: {
  groupId: string;
  role: Role;
  path: string;
  limit?: number;
}): UnlinkedMention[] {
  const { groupId, path } = opts;
  const limit = opts.limit ?? 20;
  const db = getDb();
  const hidden = (alias: string): string => hiddenNotesSql(alias, visibilityFor(opts.role));

  const self = db
    .query<{ title: string }, [string, string]>(
      `SELECT n.title FROM notes n WHERE n.group_id = ? AND n.path = ?${hidden('n')}`,
    )
    .get(groupId, path);
  if (!self) return [];

  const aliases = db
    .query<{ alias: string }, [string, string]>('SELECT alias FROM aliases WHERE group_id = ? AND path = ?')
    .all(groupId, path)
    .map((r) => r.alias);
  const terms = [...new Set([self.title, ...aliases].map((t) => t.trim()))].filter(
    (t) => [...t].length >= MIN_TERM_LENGTH,
  );

  const found = new Map<string, UnlinkedMention & { updatedAt: number }>();
  for (const term of terms) {
    const match = worldFtsMatch(groupId, term);
    if (!match) continue;
    const re = wholeWord(term);
    const rows = db
      .query<Candidate, [string, string, string, string, string, number]>(
        `SELECT n.path, n.title, n.content_text, n.updated_at
           FROM notes_fts
           JOIN notes n ON n.group_id = notes_fts.group_id AND n.path = notes_fts.path
          WHERE notes_fts MATCH ? AND notes_fts.group_id = ?
            AND n.path != ?${hidden('n')}
            AND NOT EXISTS (
              SELECT 1 FROM note_links l
               WHERE l.group_id = n.group_id
                 AND ((l.from_path = n.path AND l.to_path = ?) OR (l.from_path = ? AND l.to_path = n.path)))
          ORDER BY n.updated_at DESC
          LIMIT ?`,
      )
      .all(match, groupId, path, path, path, CANDIDATES_PER_TERM);
    for (const r of rows) {
      if (found.has(r.path)) continue;
      const m = re.exec(r.content_text);
      if (!m) continue;
      found.set(r.path, {
        path: r.path,
        title: r.title,
        snippet: snippetAround(r.content_text, m.index, m[0].length),
        updatedAt: r.updated_at,
      });
    }
  }

  return [...found.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ path: p, title, snippet }) => ({ path: p, title, snippet }));
}
