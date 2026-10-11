// Suggestions: what a Wrap-up offers a Character's Player.
//
// A Wrap-up never changes a Character. It stores a Suggestion per
// (Session, Character) for the Character's Player, who accepts or
// dismisses it. Accepting adds a History entry (story) and puts the
// items in the inventory; it never touches stats. See
// docs/adr/0001-wrap-up-on-close.md.
//
// Only the Player a Suggestion was addressed to can see or resolve it.
// Anyone else, and anything hidden from them, reads as not found.

import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { loadNote, visibilityFor, type NoteRow } from '@/lib/notes';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { validateSheet } from '@/lib/validateSheet';
import { syncNoteToMaster } from '@/lib/userCharacterSync';
import { addHistoryEntry, applyNoteEdit } from '@/lib/note-edits';
import { signalSheetChanged } from '@/collab/server';
import type { Role, Suggestion } from '@/lib/wrap-up';

export type SuggestedItem = { name: string; quantity: number };

/** A pending Suggestion as its Player sees it. */
export type PendingSuggestion = {
  id: string;
  sessionPath: string;
  sessionTitle: string;
  characterPath: string;
  characterTitle: string;
  story: string | null;
  items: SuggestedItem[];
  createdAt: number;
};

export const MAX_PENDING_LISTED = 50;

// ── Storing (called by Wrap-up apply) ──────────────────────────────────

export type StoredSuggestions = {
  stored: number;
  /** Suggestions that went nowhere, and why. A Character with no Player
   *  has nobody to offer one to. */
  skipped: Array<{ id: string; reason: 'not_visible' | 'no_player' }>;
};

/** Holds each Suggestion for the Player of its Character, resolved now.
 *  One per (Session, Character): a Suggestion already held, accepted or
 *  dismissed is never added again, so re-applying only adds what is new. */
export function storeSuggestions(opts: {
  groupId: string;
  sessionPath: string;
  suggestions: readonly Suggestion[];
  /** Whether the closer may see the Character Note. */
  isVisible: (characterPath: string) => boolean;
}): StoredSuggestions {
  const db = getDb();
  const out: StoredSuggestions = { stored: 0, skipped: [] };
  for (const s of opts.suggestions) {
    if (!opts.isVisible(s.characterPath)) {
      out.skipped.push({ id: s.id, reason: 'not_visible' });
      continue;
    }
    const owner = db
      .query<{ player_user_id: string | null }, [string, string]>(
        'SELECT player_user_id FROM characters WHERE group_id = ? AND note_path = ?',
      )
      .get(opts.groupId, s.characterPath)?.player_user_id;
    if (!owner) {
      out.skipped.push({ id: s.id, reason: 'no_player' });
      continue;
    }
    const res = db
      .query(
        `INSERT OR IGNORE INTO character_suggestions
           (id, group_id, session_path, character_path, owner_user_id, story, items_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(), opts.groupId, opts.sessionPath, s.characterPath, owner,
        s.story, JSON.stringify(s.items), Date.now(),
      );
    out.stored += res.changes;
  }
  return out;
}

// ── Reading ────────────────────────────────────────────────────────────

type Row = {
  id: string;
  session_path: string;
  session_title: string;
  character_path: string;
  character_title: string;
  story: string | null;
  items_json: string;
  status: 'pending' | 'accepted' | 'dismissed';
  created_at: number;
};

/** `userId`'s Suggestions, newest first, that they still own (the
 *  Character is still theirs) and may still see (neither the Character
 *  nor the Session is hidden from `role`). `id` narrows to one. */
function mine(opts: {
  groupId: string;
  role: Role;
  userId: string;
  id?: string;
  status?: Row['status'];
  limit: number;
}): Row[] {
  const vis = visibilityFor(opts.role);
  const hidden = (alias: string): string =>
    `${vis.hideDmOnly ? ` AND ${alias}.dm_only = 0` : ''}${vis.hideGmOnly ? ` AND ${alias}.gm_only = 0` : ''}`;
  const args: Array<string | number> = [opts.groupId, opts.userId];
  if (opts.id) args.push(opts.id);
  if (opts.status) args.push(opts.status);
  args.push(opts.limit);
  return getDb()
    .query<Row, Array<string | number>>(
      `SELECT s.id, s.session_path, sn.title AS session_title,
              s.character_path, cn.title AS character_title,
              s.story, s.items_json, s.status, s.created_at
         FROM character_suggestions s
         JOIN characters c
           ON c.group_id = s.group_id AND c.note_path = s.character_path
          AND c.player_user_id = s.owner_user_id
         JOIN notes cn ON cn.group_id = s.group_id AND cn.path = s.character_path${hidden('cn')}
         JOIN notes sn ON sn.group_id = s.group_id AND sn.path = s.session_path${hidden('sn')}
        WHERE s.group_id = ? AND s.owner_user_id = ?
          ${opts.id ? 'AND s.id = ?' : ''}
          ${opts.status ? 'AND s.status = ?' : ''}
        ORDER BY s.created_at DESC, s.id
        LIMIT ?`,
    )
    .all(...args);
}

/** The pending Suggestions for `userId` to accept or dismiss. */
export function listMySuggestions(opts: {
  groupId: string;
  role: Role;
  userId: string;
}): PendingSuggestion[] {
  return mine({ ...opts, status: 'pending', limit: MAX_PENDING_LISTED }).map((r) => ({
    id: r.id,
    sessionPath: r.session_path,
    sessionTitle: r.session_title,
    characterPath: r.character_path,
    characterTitle: r.character_title,
    story: r.story,
    items: JSON.parse(r.items_json) as SuggestedItem[],
    createdAt: r.created_at,
  }));
}

// ── Resolving ──────────────────────────────────────────────────────────

export type DismissResult =
  | { status: 'ok'; changed: boolean }
  | { status: 'not_found' }
  /** Already resolved the other way. */
  | { status: 'conflict'; resolved: 'accepted' | 'dismissed' };

export type ResolveResult =
  | DismissResult
  /** The Character's Sheet would no longer validate with the items in it. */
  | { status: 'invalid_sheet' }
  /** The Character Note refused the History entry. */
  | { status: 'edit_failed'; reason: string };

/** Accepts one of `userId`'s Suggestions: a History entry for the story
 *  and the items added to the inventory. Accepting twice changes nothing
 *  the second time. Nothing is written unless the Sheet with the items
 *  in it validates, so a refused accept leaves the Character untouched. */
export async function acceptSuggestion(opts: {
  groupId: string;
  role: Role;
  userId: string;
  id: string;
}): Promise<ResolveResult> {
  const { groupId, userId } = opts;
  const row = mine({ ...opts, limit: 1 })[0];
  if (!row) return { status: 'not_found' };
  if (row.status === 'accepted') return { status: 'ok', changed: false };
  if (row.status === 'dismissed') return { status: 'conflict', resolved: 'dismissed' };

  const items = JSON.parse(row.items_json) as SuggestedItem[];
  // Validate the Sheet before anything is written, so an invalid one
  // cannot leave a History entry behind.
  if (items.length) {
    const plan = planInventory(groupId, row.character_path, items);
    if (plan === 'not_found') return { status: 'not_found' };
    if (plan === 'invalid') return { status: 'invalid_sheet' };
  }

  // Claim before writing so a concurrent accept cannot add the items twice.
  if (!resolve(groupId, row.id, 'pending', 'accepted')) return { status: 'ok', changed: false };

  try {
    if (row.story) {
      const edit = await applyNoteEdit({
        groupId,
        path: row.character_path,
        userId,
        edit: (doc) =>
          addHistoryEntry(doc, {
            sessionPath: row.session_path,
            sessionTitle: row.session_title,
            text: row.story!,
          }),
      });
      if (edit.status === 'not_found') {
        release(groupId, row.id);
        return { status: 'not_found' };
      }
      if (edit.status === 'rejected') {
        release(groupId, row.id);
        return { status: 'edit_failed', reason: edit.reason };
      }
    }
    if (items.length) {
      // Planned again: the Sheet may have been edited while the History
      // entry was written. A retried accept is safe either way, since a
      // Session already in the History is not added twice.
      const plan = planInventory(groupId, row.character_path, items);
      if (plan === 'not_found') {
        release(groupId, row.id);
        return { status: 'not_found' };
      }
      if (plan === 'invalid') {
        release(groupId, row.id);
        return { status: 'invalid_sheet' };
      }
      writeInventory(groupId, row.character_path, userId, plan);
    }
  } catch (err) {
    release(groupId, row.id);
    throw err;
  }
  return { status: 'ok', changed: true };
}

/** Dismisses one of `userId`'s Suggestions. The Character is left as it is. */
export function dismissSuggestion(opts: {
  groupId: string;
  role: Role;
  userId: string;
  id: string;
}): DismissResult {
  const row = mine({ ...opts, limit: 1 })[0];
  if (!row) return { status: 'not_found' };
  if (row.status === 'dismissed') return { status: 'ok', changed: false };
  if (row.status === 'accepted') return { status: 'conflict', resolved: 'accepted' };
  return { status: 'ok', changed: resolve(opts.groupId, row.id, 'pending', 'dismissed') };
}

/** Moves a Suggestion from `from` to `to`; false when it was no longer `from`. */
function resolve(groupId: string, id: string, from: Row['status'], to: 'accepted' | 'dismissed'): boolean {
  return (
    getDb()
      .query('UPDATE character_suggestions SET status = ?, resolved_at = ? WHERE group_id = ? AND id = ? AND status = ?')
      .run(to, Date.now(), groupId, id, from).changes > 0
  );
}

/** Undoes a claim after a failed write so the Player can try again. */
function release(groupId: string, id: string): void {
  getDb()
    .query("UPDATE character_suggestions SET status = 'pending', resolved_at = NULL WHERE group_id = ? AND id = ?")
    .run(groupId, id);
}

// ── Inventory ──────────────────────────────────────────────────────────

type InventoryPlan = {
  note: NoteRow;
  frontmatter: Record<string, unknown>;
  sheet: Record<string, unknown>;
};

/** The Character's frontmatter with `items` added to the inventory and
 *  nothing else changed, or why it cannot be. Both shapes are kept in
 *  step: the nested `sheet.inventory` entries, and the legacy flat
 *  `sheet.items` strings that the older CharacterSheet panel lists as
 *  typed (a quantity above one reads `Name ×N`). An item already
 *  carried, matched by name without regard to case, has its quantity
 *  raised in both. Writes nothing. */
function planInventory(
  groupId: string,
  path: string,
  items: readonly SuggestedItem[],
): InventoryPlan | 'not_found' | 'invalid' {
  const note: NoteRow | null = loadNote(groupId, path);
  if (!note) return 'not_found';
  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>;
  } catch {
    fm = {};
  }
  const sheet = isRecord(fm.sheet) ? { ...fm.sheet } : {};

  const flat = Array.isArray(sheet.items) ? [...(sheet.items as unknown[])] : [];
  const nested = Array.isArray(sheet.inventory) ? [...(sheet.inventory as unknown[])] : [];
  for (const item of items) {
    const key = item.name.trim().toLowerCase();

    const flatAt = flat.findIndex((e) => typeof e === 'string' && parseFlat(e).name.toLowerCase() === key);
    if (flatAt === -1) {
      flat.push(flatLabel(item.name, item.quantity));
    } else {
      const have = parseFlat(flat[flatAt] as string);
      flat[flatAt] = flatLabel(have.name, have.quantity + item.quantity);
    }

    const at = nested.findIndex((e) => entryName(e)?.trim().toLowerCase() === key);
    if (at === -1) {
      nested.push({ ref: { name: item.name }, quantity: item.quantity, equipped: false, attuned: false });
    } else {
      const entry = nested[at] as Record<string, unknown>;
      nested[at] = { ...entry, quantity: Number(entry.quantity ?? 1) + item.quantity };
    }
  }
  sheet.items = flat;
  sheet.inventory = nested;

  // Validation only gates the write: storing its parsed result would
  // fill in default stats on a Sheet that never had them.
  if (!validateSheet(typeof fm.kind === 'string' ? fm.kind : undefined, sheet).ok) return 'invalid';
  return { note, frontmatter: fm, sheet };
}

function writeInventory(groupId: string, path: string, userId: string, plan: InventoryPlan): void {
  const nextFm = JSON.stringify({ ...plan.frontmatter, sheet: plan.sheet });
  getDb()
    .query('UPDATE notes SET frontmatter_json = ?, updated_at = ?, updated_by = ? WHERE group_id = ? AND path = ?')
    .run(nextFm, Date.now(), userId, groupId, path);
  try {
    deriveAllIndexes({ groupId, notePath: path, frontmatterJson: nextFm });
  } catch (err) {
    console.error('[character-suggestions] derive failed:', err);
  }
  try {
    syncNoteToMaster(plan.note.id);
  } catch (err) {
    console.error('[character-suggestions] sync to master failed:', err);
  }
  // Frontmatter is not in the Y.Doc: ping open editors to re-fetch it.
  signalSheetChanged(groupId, path);
}

/** A legacy flat item as the panel lists it: `Rope` or `Rope ×2`. */
function parseFlat(label: string): { name: string; quantity: number } {
  const m = /^(.*?)\s*×\s*(\d+)\s*$/.exec(label);
  return m?.[1] ? { name: m[1].trim(), quantity: Number(m[2]) } : { name: label.trim(), quantity: 1 };
}

function flatLabel(name: string, quantity: number): string {
  return quantity > 1 ? `${name} ×${quantity}` : name;
}

function entryName(entry: unknown): string | null {
  if (!isRecord(entry) || !isRecord(entry.ref)) return null;
  return typeof entry.ref.name === 'string' ? entry.ref.name : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
