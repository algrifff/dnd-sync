// Cross-world reads for a user's Home (/me). Each one spans every World
// the user is a member of and gates every Note by the user's role in
// that Note's own World, so a World they have left never appears and a
// Note hidden from them there is never surfaced, not even by name.

import { getDb } from './db';
import { visibleToMemberSql } from './notes';

export type OpenSession = {
  worldId: string;
  worldName: string;
  path: string;
  title: string;
  /** Open Sessions in this World the user can see, this one included.
   *  Sessions start open, so an imported log never closed counts too. */
  openCount: number;
};

/** Worlds shown in the Open sessions strip at most. */
export const MAX_OPEN_SESSION_WORLDS = 6;

/** The newest open Session per World, newest World first. */
export function listOpenSessionsForUser(userId: string): OpenSession[] {
  return getDb()
    .query<OpenSession, [string, number]>(
      `SELECT worldId, worldName, path, title, openCount FROM (
         SELECT sn.group_id AS worldId,
                g.name      AS worldName,
                sn.note_path AS path,
                COALESCE(NULLIF(n.title, ''), sn.title, sn.note_path) AS title,
                n.updated_at AS updatedAt,
                COUNT(*) OVER (PARTITION BY sn.group_id) AS openCount,
                ROW_NUMBER() OVER (
                  PARTITION BY sn.group_id
                  ORDER BY sn.session_date IS NULL, sn.session_date DESC, n.updated_at DESC
                ) AS rank
           FROM session_notes sn
           JOIN group_members gm ON gm.group_id = sn.group_id AND gm.user_id = ?
           JOIN groups g ON g.id = sn.group_id
           JOIN notes n ON n.group_id = sn.group_id AND n.path = sn.note_path
          WHERE sn.status = 'open'
            AND (${visibleToMemberSql('n', 'gm')})
       )
       WHERE rank = 1
       ORDER BY updatedAt DESC
       LIMIT ?`,
    )
    .all(userId, MAX_OPEN_SESSION_WORLDS);
}

/** For each of the user's Characters, the Worlds it is played in: those
 *  it is bound into, where the user is still a member and may still see
 *  the bound Character Note. Characters in no World are absent. */
export function listCharacterWorlds(userId: string): Record<string, string[]> {
  const rows = getDb()
    .query<{ characterId: string; worldId: string }, [string]>(
      `SELECT b.user_character_id AS characterId, b.group_id AS worldId
         FROM user_character_bindings b
         JOIN user_characters uc ON uc.id = b.user_character_id
         JOIN group_members gm ON gm.group_id = b.group_id AND gm.user_id = uc.owner_user_id
         JOIN notes n ON n.id = b.note_id AND n.group_id = b.group_id
        WHERE uc.owner_user_id = ?
          AND (${visibleToMemberSql('n', 'gm')})
        GROUP BY b.user_character_id, b.group_id
        ORDER BY MIN(b.joined_at)`,
    )
    .all(userId);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.characterId] ??= []).push(r.worldId);
  return out;
}
