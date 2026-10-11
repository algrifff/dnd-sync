// character_suggestions keeps the Character and Session Note paths as
// soft references (no FK), so every place that renames a Note must
// repoint them or the Suggestion stops matching its Character.

import { getDb } from '@/lib/db';

/** Repoints Suggestions that name the Note at `from` to `to`. Call it
 *  inside the same transaction as the Note's own path update. */
export function repointSuggestionPaths(groupId: string, from: string, to: string): void {
  const db = getDb();
  db.query(
    'UPDATE character_suggestions SET character_path = ? WHERE group_id = ? AND character_path = ?',
  ).run(to, groupId, from);
  db.query(
    'UPDATE character_suggestions SET session_path = ? WHERE group_id = ? AND session_path = ?',
  ).run(to, groupId, from);
}
