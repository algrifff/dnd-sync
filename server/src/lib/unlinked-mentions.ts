// Unlinked mentions: Notes whose text names this Note's title or an alias
// as a whole word without linking to it (docs/adr/0003-connections-panel-
// and-manual-relationships.md). Read only; "Link" in the panel adds the
// plain manual link and never edits anyone's text.

import { getDb } from '@/lib/db';
import { hiddenNotesSql, visibilityFor, type MemberRole as Role } from '@/lib/notes';
import { worldBodyPhraseMatch } from '@/lib/search';

export type UnlinkedMention = { path: string; title: string; snippet: string };

const MIN_TERM_LENGTH = 4;
/** Candidate Notes read per page. FTS stems ("towering" matches "tower"),
 *  so it is looser than a whole-word match; pages are read newest first
 *  until `limit` real hits turn up or the candidates run out. */
const PAGE_SIZE = 200;
/** Hard stop on candidates read per term, so a very common name is bounded. */
const MAX_CANDIDATES_PER_TERM = 5000;
const SNIPPET_RADIUS = 40;

type Candidate = { path: string; title: string; content_text: string; updated_at: number };

const WORD_CHAR = /[\p{L}\p{N}_]/u;

const isWordChar = (ch: string): boolean => ch !== '' && WORD_CHAR.test(ch);

const WHITESPACE = /\s/u;

const isSpace = (ch: string | undefined): boolean => ch !== undefined && WHITESPACE.test(ch);

const sameChar = (a: string, b: string): boolean =>
  a === b || a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** First whole-word, case-insensitive occurrence of `term` in `text`: not
 *  flanked by a letter, digit or underscore. Walks the original text one
 *  character at a time (no lowercased copy, so `İ` cannot shift offsets);
 *  any run of whitespace in the text, a newline or NBSP included, matches
 *  the gap between two words of the term. No regex is built from `term`.
 *  `index` and `length` are in the ORIGINAL text. */
export function findWholeWord(text: string, term: string): { index: number; length: number } | null {
  const words = term.split(/\s+/u).filter(Boolean);
  if (words.length === 0) return null;
  const needle = Array.from(words.join(' '));
  const chars = Array.from(text);
  const offsets: number[] = [];
  let at = 0;
  for (const ch of chars) {
    offsets.push(at);
    at += ch.length;
  }
  offsets.push(at);

  for (let i = 0; i < chars.length; i++) {
    if (isSpace(chars[i]) || !sameChar(chars[i]!, needle[0]!)) continue;
    let ti = i;
    let ok = true;
    for (let n = 0; n < needle.length && ok; n++) {
      if (needle[n] === ' ') {
        if (!isSpace(chars[ti])) ok = false;
        while (isSpace(chars[ti])) ti++;
      } else if (ti < chars.length && sameChar(chars[ti]!, needle[n]!)) {
        ti++;
      } else {
        ok = false;
      }
    }
    if (!ok) continue;
    if (isWordChar(chars[i - 1] ?? '') || isWordChar(chars[ti] ?? '')) continue;
    return { index: offsets[i]!, length: offsets[ti]! - offsets[i]! };
  }
  return null;
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
    const match = worldBodyPhraseMatch(groupId, term);
    if (!match) continue;
    let termHits = 0;
    for (let offset = 0; offset < MAX_CANDIDATES_PER_TERM && termHits < limit; offset += PAGE_SIZE) {
      const rows = db
        .query<Candidate, [string, string, string, string, string, number, number]>(
          `SELECT n.path, n.title, n.content_text, n.updated_at
             FROM notes_fts
             JOIN notes n ON n.group_id = notes_fts.group_id AND n.path = notes_fts.path
            WHERE notes_fts MATCH ? AND notes_fts.group_id = ?
              AND n.path != ?${hidden('n')}
              AND NOT EXISTS (
                SELECT 1 FROM note_links l
                 WHERE l.group_id = n.group_id
                   AND ((l.from_path = n.path AND l.to_path = ?) OR (l.from_path = ? AND l.to_path = n.path)))
            ORDER BY n.updated_at DESC, n.path
            LIMIT ? OFFSET ?`,
        )
        .all(match, groupId, path, path, path, PAGE_SIZE, offset);
      for (const r of rows) {
        const m = findWholeWord(r.content_text, term);
        if (!m) continue;
        termHits++;
        if (found.has(r.path)) continue;
        found.set(r.path, {
          path: r.path,
          title: r.title,
          snippet: snippetAround(r.content_text, m.index, m.length),
          updatedAt: r.updated_at,
        });
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }

  return [...found.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ path: p, title, snippet }) => ({ path: p, title, snippet }));
}
