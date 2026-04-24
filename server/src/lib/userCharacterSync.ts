// Two-way sync between user_characters (user-level master records) and
// the per-world notes they are bound to via user_character_bindings.
//
// Direction A — master → notes (`syncMasterToNotes`):
//   Called after `updateUserCharacter` writes. For every binding, we
//   shallow-merge the master's sheet_json into the bound note's
//   frontmatter.sheet, mirror to the legacy flat keys the old
//   CharacterSheet side-panel still reads, and re-derive indexes.
//
// Direction B — note → master (`syncNoteToMaster`):
//   Called after `/api/notes/sheet` writes. If the note is a binding
//   mirror, we reverse-merge its sheet back into the master row.
//
// Loop-guard: the sync functions run synchronous SQL, so "mid-sync" is
// a short imperative window inside a single request. Module-scoped Sets
// tag the currently-syncing ids; the opposite direction bails early if
// it sees its id there, so a master write that triggers A cannot then
// trigger B on the note it just wrote.

import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { getDb } from './db';
import { deriveAllIndexes } from './derive-indexes';
import { getPmSchema } from './pm-schema';
import { validateSheet } from './validateSheet';
import type { UserCharacterKind } from './userCharacters';

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

const syncingNoteIds = new Set<string>();
const syncingUserCharacterIds = new Set<string>();

type BindingRow = {
  user_character_id: string;
  group_id: string;
  campaign_slug: string;
  note_id: string;
};

export function syncMasterToNotes(userCharacterId: string): void {
  if (syncingUserCharacterIds.has(userCharacterId)) return;
  const db = getDb();
  const uc = db
    .query<
      {
        name: string;
        sheet_json: string;
        portrait_url: string | null;
        body_json: string | null;
        body_md: string | null;
      },
      [string]
    >(
      'SELECT name, sheet_json, portrait_url, body_json, body_md FROM user_characters WHERE id = ?',
    )
    .get(userCharacterId);
  if (!uc) return;
  const bindings = db
    .query<BindingRow, [string]>(
      'SELECT user_character_id, group_id, campaign_slug, note_id FROM user_character_bindings WHERE user_character_id = ?',
    )
    .all(userCharacterId);
  if (bindings.length === 0) return;

  const masterSheet = safeParseObject(uc.sheet_json);
  const masterBody = uc.body_json ? safeParseObject(uc.body_json) : null;

  for (const b of bindings) {
    syncingNoteIds.add(b.note_id);
    try {
      const noteRow = db
        .query<{ path: string; frontmatter_json: string }, [string]>(
          'SELECT path, frontmatter_json FROM notes WHERE id = ?',
        )
        .get(b.note_id);
      if (!noteRow) continue;
      const fm = safeParseObject(noteRow.frontmatter_json);
      const currentSheet =
        fm.sheet && typeof fm.sheet === 'object' && !Array.isArray(fm.sheet)
          ? ({ ...(fm.sheet as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      const merged: Record<string, unknown> = {
        ...currentSheet,
        ...masterSheet,
        name: uc.name,
      };
      applyLegacyMirror(merged);
      const nextFm: Record<string, unknown> = { ...fm, sheet: merged };

      // Body sync: push master's TipTap doc into the bound note's
      // content_json AND yjs_state. Both are needed — the in-world
      // editor binds Tiptap to the Y.Doc decoded from yjs_state, while
      // the server-side renderer reads content_json. Without rebuilding
      // yjs_state, the live editor would clobber the new content_json
      // on the next sync. Skip when master has no body yet.
      let nextContentJson: string | null = null;
      let nextYjsState: Uint8Array | null = null;
      let nextBodyMd: string | null = null;
      if (masterBody) {
        try {
          const schema = getPmSchema();
          const ydoc = prosemirrorJSONToYDoc(schema, masterBody, 'default');
          ydoc.getText('title').insert(0, uc.name);
          nextYjsState = Y.encodeStateAsUpdate(ydoc);
          nextContentJson = JSON.stringify(masterBody);
          nextBodyMd = uc.body_md;
        } catch (err) {
          console.error('[userCharacterSync] body encode failed:', err);
        }
      }

      if (nextContentJson && nextYjsState) {
        db.query(
          `UPDATE notes SET frontmatter_json = ?, content_json = ?, content_md = ?, yjs_state = ?, updated_at = ? WHERE id = ?`,
        ).run(
          JSON.stringify(nextFm),
          nextContentJson,
          nextBodyMd ?? '',
          nextYjsState,
          Date.now(),
          b.note_id,
        );
      } else {
        db.query(
          `UPDATE notes SET frontmatter_json = ?, updated_at = ? WHERE id = ?`,
        ).run(JSON.stringify(nextFm), Date.now(), b.note_id);
      }
      try {
        deriveAllIndexes({
          groupId: b.group_id,
          notePath: noteRow.path,
          frontmatterJson: JSON.stringify(nextFm),
        });
      } catch (err) {
        console.error('[userCharacterSync] derive failed:', err);
      }
    } finally {
      syncingNoteIds.delete(b.note_id);
    }
  }
}

export function syncNoteToMaster(noteId: string): void {
  if (syncingNoteIds.has(noteId)) return;
  const db = getDb();
  const binding = db
    .query<{ user_character_id: string }, [string]>(
      'SELECT user_character_id FROM user_character_bindings WHERE note_id = ?',
    )
    .get(noteId);
  if (!binding) return;
  syncingUserCharacterIds.add(binding.user_character_id);
  try {
    const noteRow = db
      .query<{ frontmatter_json: string }, [string]>(
        'SELECT frontmatter_json FROM notes WHERE id = ?',
      )
      .get(noteId);
    if (!noteRow) return;
    const fm = safeParseObject(noteRow.frontmatter_json);
    const noteSheet =
      fm.sheet && typeof fm.sheet === 'object' && !Array.isArray(fm.sheet)
        ? ({ ...(fm.sheet as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const ucRow = db
      .query<{ kind: string; name: string; sheet_json: string }, [string]>(
        'SELECT kind, name, sheet_json FROM user_characters WHERE id = ?',
      )
      .get(binding.user_character_id);
    if (!ucRow) return;
    const masterSheet = safeParseObject(ucRow.sheet_json);
    const nextName =
      typeof noteSheet.name === 'string' && noteSheet.name.trim()
        ? noteSheet.name.trim()
        : ucRow.name;
    const merged: Record<string, unknown> = {
      ...masterSheet,
      ...noteSheet,
      name: nextName,
    };
    const kind: UserCharacterKind =
      ucRow.kind === 'person' ? 'person' : 'character';
    const val = validateSheet(kind, merged);
    if (!val.ok) return;
    db.query(
      `UPDATE user_characters SET name = ?, sheet_json = ?, updated_at = ? WHERE id = ?`,
    ).run(
      nextName,
      JSON.stringify((val.data as Record<string, unknown>) ?? merged),
      Date.now(),
      binding.user_character_id,
    );
  } finally {
    syncingUserCharacterIds.delete(binding.user_character_id);
  }
}

function safeParseObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* tolerate corrupt JSON */
  }
  return {};
}

function applyLegacyMirror(sheet: Record<string, unknown>): void {
  const hp = sheet.hit_points;
  if (hp && typeof hp === 'object' && !Array.isArray(hp)) {
    const h = hp as { current?: number; max?: number };
    if (typeof h.current === 'number') sheet.hp_current = h.current;
    if (typeof h.max === 'number') sheet.hp_max = h.max;
  }
  const ac = sheet.armor_class;
  if (ac && typeof ac === 'object' && !Array.isArray(ac)) {
    const a = ac as { value?: number };
    if (typeof a.value === 'number') sheet.ac = a.value;
  }
  const ab = sheet.ability_scores;
  if (ab && typeof ab === 'object' && !Array.isArray(ab)) {
    const a = ab as Record<string, unknown>;
    for (const key of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
      if (typeof a[key] === 'number') sheet[key] = a[key];
    }
  }
}
