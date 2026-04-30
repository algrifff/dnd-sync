#!/usr/bin/env bun
// Export a single world (group_id) from the local SQLite into a portable
// JSON bundle that can be applied to another DB (production / Railway)
// via apply-bundle.ts.
//
// What lands in the bundle:
//   * the `groups` row + `group_members` rows (admin link to algrifff)
//   * the `users` row for algrifff (apply-bundle skips if user exists)
//   * every notes row scoped to this group, with yjs_state base64-encoded
//   * note_links, tags, aliases, folder_markers, campaigns
//   * derived index tables (characters, character_campaigns, items,
//     locations, creatures, session_notes, asset_tags, ai_personalities)
//   * assets (rows + raw file bytes base64-encoded so the apply can
//     restore the on-disk content-addressed files)
//
// What we deliberately skip:
//   * audit_log         — observability only, not load-bearing
//   * import_jobs       — local-only state for the dropped AI flow
//   * group_invite_tokens — temporary share links
//   * user_character_bindings / user_characters — these are user-scoped,
//     created on prod when each player hits "Transfer character"
//   * notes_fts — rebuilt automatically by triggers when notes INSERT
//
// Usage:
//   bun run scripts/main-notes-import/export-bundle.ts \
//     --group-id <uuid> \
//     --user-id <uuid-for-algrifff> \
//     [--out bundle.json]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDb } from '../../server/src/lib/db';
import { assetPath } from '../../server/src/lib/assets';

type Args = { groupId: string; userId: string; out: string };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const groupId = get('--group-id');
  const userId = get('--user-id');
  if (!groupId) throw new Error('missing --group-id');
  if (!userId) throw new Error('missing --user-id');
  return { groupId, userId, out: get('--out') ?? 'bundle.json' };
}

function dumpScoped<R>(table: string, groupId: string): R[] {
  return getDb()
    .query<R, [string]>(`SELECT * FROM ${table} WHERE group_id = ?`)
    .all(groupId);
}

function encodeBuffer(buf: Buffer | Uint8Array | null | undefined): string | null {
  if (!buf) return null;
  return Buffer.from(buf).toString('base64');
}

function main(): void {
  const { groupId, userId, out } = parseArgs();
  const db = getDb();

  // 1. Group + membership.
  const group = db
    .query<Record<string, unknown>, [string]>(
      'SELECT * FROM groups WHERE id = ?',
    )
    .get(groupId);
  if (!group) throw new Error(`group ${groupId} not found`);
  // groups.icon_blob is a BLOB — encode if present.
  if (group.icon_blob) {
    group.icon_blob = encodeBuffer(group.icon_blob as Buffer);
  }

  // Only export the target user's membership row. Other locally-bound
  // users (e.g. the local "admin" account I added for verification)
  // don't exist on prod and would FK-fail on apply.
  const members = db
    .query<Record<string, unknown>, [string, string]>(
      'SELECT * FROM group_members WHERE group_id = ? AND user_id = ?',
    )
    .all(groupId, userId);

  // 2. The algrifff user row (one of the members; apply will skip if a
  // user with the same id already exists on the target).
  const user = db
    .query<Record<string, unknown>, [string]>(
      'SELECT * FROM users WHERE id = ?',
    )
    .get(userId);
  if (!user) throw new Error(`user ${userId} not found`);
  if (user.avatar_blob) user.avatar_blob = encodeBuffer(user.avatar_blob as Buffer);

  // Rewrite every user-FK column to the target userId so the bundle
  // is self-contained. Some rows (auto-managed folder index notes,
  // notes touched by the local admin during verification) reference
  // local-only users that don't exist on prod.
  const userFkColumns: Record<string, string[]> = {
    notes: ['created_by', 'updated_by'],
    assets: ['uploaded_by'],
    characters: ['player_user_id'],
    session_notes: ['closed_by'],
    ai_personalities: ['created_by'],
    group_invite_tokens: ['created_by'],
  };
  function pinUserFks(table: string, rows: Array<Record<string, unknown>>): void {
    const cols = userFkColumns[table];
    if (!cols) return;
    for (const r of rows) {
      for (const c of cols) {
        if (r[c] != null) r[c] = userId;
      }
    }
  }

  // 3. Notes — yjs_state is binary, encode it.
  const notes = db
    .query<Record<string, unknown>, [string]>(
      'SELECT * FROM notes WHERE group_id = ?',
    )
    .all(groupId);
  for (const n of notes) {
    n.yjs_state = encodeBuffer(n.yjs_state as Buffer | null);
  }
  pinUserFks('notes', notes);

  // 4. Assets — both the row metadata AND the on-disk file content.
  const assetRows = dumpScoped<Record<string, unknown>>('assets', groupId);
  pinUserFks('assets', assetRows);
  const assetFiles: Array<{ hash: string; mime: string; data: string }> = [];
  for (const a of assetRows) {
    const hash = String(a.hash);
    const mime = String(a.mime);
    const path = assetPath(hash, mime);
    if (existsSync(path)) {
      assetFiles.push({ hash, mime, data: readFileSync(path).toString('base64') });
    } else {
      console.warn(`[export] asset blob missing on disk: ${path}`);
    }
  }

  const bundle = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    groupId,
    userId,
    user,
    group,
    group_members: members,
    notes,
    note_links: dumpScoped('note_links', groupId),
    tags: dumpScoped('tags', groupId),
    aliases: dumpScoped('aliases', groupId),
    folder_markers: dumpScoped('folder_markers', groupId),
    campaigns: dumpScoped('campaigns', groupId),
    characters: ((): unknown => {
      const r = dumpScoped<Record<string, unknown>>('characters', groupId);
      pinUserFks('characters', r);
      return r;
    })(),
    character_campaigns: dumpScoped('character_campaigns', groupId),
    items: dumpScoped('items', groupId),
    locations: dumpScoped('locations', groupId),
    creatures: dumpScoped('creatures', groupId),
    session_notes: ((): unknown => {
      const r = dumpScoped<Record<string, unknown>>('session_notes', groupId);
      pinUserFks('session_notes', r);
      return r;
    })(),
    asset_tags: dumpScoped('asset_tags', groupId),
    ai_personalities: ((): unknown => {
      const r = dumpScoped<Record<string, unknown>>('ai_personalities', groupId);
      pinUserFks('ai_personalities', r);
      return r;
    })(),
    assets: assetRows,
    asset_files: assetFiles,
  };

  writeFileSync(out, JSON.stringify(bundle));
  console.log(`[export] wrote ${out}`);
  console.log(`[export]   notes:           ${notes.length}`);
  console.log(`[export]   assets (rows):   ${assetRows.length}`);
  console.log(`[export]   assets (blobs):  ${assetFiles.length}`);
  console.log(`[export]   note_links:      ${bundle.note_links.length}`);
  console.log(`[export]   tags:            ${bundle.tags.length}`);
  console.log(`[export]   characters:      ${bundle.characters.length}`);
  console.log(`[export]   campaigns:       ${bundle.campaigns.length}`);
  console.log(`[export]   folder_markers:  ${bundle.folder_markers.length}`);
}

main();
