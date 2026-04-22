// AI personalities: per-world named voice presets.
//
// The system prompt is built from a framework (context lines, rules,
// tool list) plus a small "## Voice" block that controls the AI's
// tone. That Voice block used to be hardcoded as the grizzled scribe;
// it is now a per-world setting so each world's admin can pick,
// name, and swap between personalities.
//
// The built-in scribe lives here as DEFAULT_PERSONALITY and is used
// whenever groups.active_personality_id is NULL. The table can be
// empty on day one — nothing to seed, nothing that can be
// accidentally deleted to break the AI.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

// ── Built-in default ───────────────────────────────────────────────────

/** The grizzled-scribe voice the app shipped with, used as fallback. */
export const DEFAULT_PERSONALITY = {
  /** Stable sentinel id used when no custom personality is selected. */
  id: 'builtin:scribe',
  name: 'Grizzled Scribe (default)',
  prompt: `You speak as a grizzled old knight who hung up the sword and took up the quill — the party's campaign scribe. Battle-worn, plainspoken, quietly amused by the chaos of adventurers. A touch of medieval cadence ("aye", "well enough", "the deed is done", "so it is written") but NEVER purple, NEVER theatrical. Short sentences. Dry wit over flourish. You log and confirm; you do not narrate.

Good: "Aye, Bram the fighter is inscribed — level three, blade at his hip. Gods keep him."
Good: "Done. Flim Flam walks the ledger now."
Good: "The waystone at Duskhallow is marked on the map. Nothing more to say."
Bad: "I have successfully created the character and populated the following fields..." (too clinical)
Bad: "Lo! A hero strides forth from the mists of Faerûn, destined to carve his name in legend!" (too purple)`,
} as const;

export const MAX_PERSONALITY_NAME_LEN = 60;
export const MAX_PERSONALITY_PROMPT_LEN = 4000;

// ── Types ──────────────────────────────────────────────────────────────

export type Personality = {
  id: string;
  groupId: string;
  name: string;
  prompt: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PersonalitySummary = {
  id: string;
  name: string;
  prompt: string;
  isBuiltin: boolean;
};

type PersonalityRow = {
  id: string;
  group_id: string;
  name: string;
  prompt: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

function rowToPersonality(r: PersonalityRow): Personality {
  return {
    id: r.id,
    groupId: r.group_id,
    name: r.name,
    prompt: r.prompt,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Reads ──────────────────────────────────────────────────────────────

export function listPersonalities(groupId: string): Personality[] {
  return getDb()
    .query<PersonalityRow, [string]>(
      `SELECT id, group_id, name, prompt, created_by, created_at, updated_at
         FROM ai_personalities
        WHERE group_id = ?
        ORDER BY name COLLATE NOCASE`,
    )
    .all(groupId)
    .map(rowToPersonality);
}

export function getPersonality(
  groupId: string,
  id: string,
): Personality | null {
  const row = getDb()
    .query<PersonalityRow, [string, string]>(
      `SELECT id, group_id, name, prompt, created_by, created_at, updated_at
         FROM ai_personalities
        WHERE group_id = ? AND id = ?`,
    )
    .get(groupId, id);
  return row ? rowToPersonality(row) : null;
}

/** Current active personality for the world, or the built-in default. */
export function getActivePersonality(groupId: string): PersonalitySummary {
  const active = getDb()
    .query<{ active_personality_id: string | null }, [string]>(
      'SELECT active_personality_id FROM groups WHERE id = ?',
    )
    .get(groupId);

  const activeId = active?.active_personality_id ?? null;
  if (activeId) {
    const p = getPersonality(groupId, activeId);
    if (p) {
      return { id: p.id, name: p.name, prompt: p.prompt, isBuiltin: false };
    }
    // Active row was deleted out from under us — silently clear it so
    // we fall through to the default on the next read. No user-visible
    // error; losing a personality shouldn't make the AI unusable.
    getDb()
      .query('UPDATE groups SET active_personality_id = NULL WHERE id = ?')
      .run(groupId);
  }

  return {
    id: DEFAULT_PERSONALITY.id,
    name: DEFAULT_PERSONALITY.name,
    prompt: DEFAULT_PERSONALITY.prompt,
    isBuiltin: true,
  };
}

// ── Writes ─────────────────────────────────────────────────────────────

function validateFields(name: string, prompt: string): void {
  if (!name.trim()) throw new Error('name is required');
  if (name.length > MAX_PERSONALITY_NAME_LEN) throw new Error('name too long');
  if (!prompt.trim()) throw new Error('prompt is required');
  if (prompt.length > MAX_PERSONALITY_PROMPT_LEN) {
    throw new Error('prompt too long');
  }
}

export function createPersonality(opts: {
  groupId: string;
  name: string;
  prompt: string;
  createdBy: string;
}): Personality {
  const name = opts.name.trim();
  const prompt = opts.prompt.trim();
  validateFields(name, prompt);

  const id = randomUUID();
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO ai_personalities
         (id, group_id, name, prompt, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, opts.groupId, name, prompt, opts.createdBy, now, now);

  return {
    id,
    groupId: opts.groupId,
    name,
    prompt,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export function updatePersonality(opts: {
  groupId: string;
  id: string;
  name?: string;
  prompt?: string;
}): Personality | null {
  const existing = getPersonality(opts.groupId, opts.id);
  if (!existing) return null;

  const name = opts.name !== undefined ? opts.name.trim() : existing.name;
  const prompt =
    opts.prompt !== undefined ? opts.prompt.trim() : existing.prompt;
  validateFields(name, prompt);

  const now = Date.now();
  getDb()
    .query(
      `UPDATE ai_personalities
          SET name = ?, prompt = ?, updated_at = ?
        WHERE group_id = ? AND id = ?`,
    )
    .run(name, prompt, now, opts.groupId, opts.id);

  return { ...existing, name, prompt, updatedAt: now };
}

/** Delete a personality. If it was the active one, clear the pointer. */
export function deletePersonality(groupId: string, id: string): boolean {
  const db = getDb();
  let removed = false;
  db.transaction(() => {
    const res = db
      .query('DELETE FROM ai_personalities WHERE group_id = ? AND id = ?')
      .run(groupId, id);
    removed = res.changes > 0;
    if (removed) {
      db.query(
        `UPDATE groups SET active_personality_id = NULL
          WHERE id = ? AND active_personality_id = ?`,
      ).run(groupId, id);
    }
  })();
  return removed;
}

/**
 * Point the world at a personality (or back to the built-in default).
 * Pass null (or the sentinel DEFAULT_PERSONALITY.id) to reset. Returns
 * false if the target row doesn't belong to this group.
 */
export function setActivePersonality(
  groupId: string,
  id: string | null,
): boolean {
  if (id === null || id === DEFAULT_PERSONALITY.id) {
    getDb()
      .query('UPDATE groups SET active_personality_id = NULL WHERE id = ?')
      .run(groupId);
    return true;
  }
  const row = getPersonality(groupId, id);
  if (!row) return false;
  getDb()
    .query('UPDATE groups SET active_personality_id = ? WHERE id = ?')
    .run(id, groupId);
  return true;
}
