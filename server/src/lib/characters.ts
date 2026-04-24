// Character + campaign derivation from note frontmatter.
//
// Characters are notes whose frontmatter carries `kind: character`.
// On every note save we parse the frontmatter and sync the
// `characters` + `character_campaigns` index tables so queries like
// "all PCs owned by alex" don't have to scan every note's JSON.
//
// Campaigns are auto-created whenever a note's path falls under a
// `Campaigns/<slug>/` folder — admins can rename the display value
// later without touching the folder.
//
// Everything in here is idempotent: running the derivation twice
// for the same note yields the same rows, and removing the
// `kind: character` frontmatter cleanly drops the index entry.

import { getDb } from './db';
import type { TemplateKind } from './templates';

/** Character roles we derive today. 'session' isn't here because
 *  sessions get their own index table in Phase 2. */
export type CharacterKind = Extract<
  TemplateKind,
  'pc' | 'npc' | 'ally' | 'villain'
>;

const CHARACTER_KINDS: readonly CharacterKind[] = [
  'pc',
  'npc',
  'ally',
  'villain',
] as const;

function isCharacterKind(v: unknown): v is CharacterKind {
  return typeof v === 'string' && (CHARACTER_KINDS as readonly string[]).includes(v);
}

type FrontmatterShape = {
  kind?: unknown;
  role?: unknown;
  player?: unknown;
  portrait?: unknown;
  campaigns?: unknown;
  sheet?: Record<string, unknown>;
};

/** Re-derive the characters + character_campaigns rows for a note
 *  from its current frontmatter JSON. If the note is no longer a
 *  character (`kind` changed or absent), the rows are cleaned up.
 *  Safe to call on every save regardless of note kind. */
export function deriveCharacterFromFrontmatter(opts: {
  groupId: string;
  notePath: string;
  frontmatterJson: string;
}): void {
  const db = getDb();

  let fm: FrontmatterShape;
  try {
    fm = JSON.parse(opts.frontmatterJson) as FrontmatterShape;
  } catch {
    fm = {};
  }

  if (fm.kind !== 'character') {
    // Not (or no longer) a character — drop any index row.
    // character_campaigns cascade-deletes via the FK.
    db.query('DELETE FROM characters WHERE group_id = ? AND note_path = ?').run(
      opts.groupId,
      opts.notePath,
    );
    return;
  }

  const role = detectRole(fm, opts.notePath);
  const sheet = (fm.sheet && typeof fm.sheet === 'object' ? fm.sheet : {}) as Record<
    string,
    unknown
  >;

  const displayName =
    strOrNull(sheet.name) ?? filenameDisplayName(opts.notePath);
  // New sheet shape has sheet.classes[0] + sheet.race.ref.name;
  // legacy shape has sheet.class + sheet.race as plain strings.
  const level = intOrNull(sheet.level) ?? extractPrimaryLevel(sheet.classes);
  const klass = strOrNull(sheet.class) ?? extractPrimaryClassName(sheet.classes);
  const race = strOrNull(sheet.race) ?? extractRefName(sheet.race);
  const portraitPath =
    strOrNull(fm.portrait) ?? strOrNull(sheet.portrait);
  const ac = extractAc(sheet);
  const hpMax = extractHp(sheet, 'max') ?? intOrNull(sheet.hp_max);
  const hpCurrent = extractHp(sheet, 'current') ?? intOrNull(sheet.hp_current);
  const hpTemporary =
    extractHp(sheet, 'temporary') ?? intOrNull(sheet.hp_temporary);
  const proficiencyBonus = intOrNull(sheet.proficiency_bonus);

  // The player field can be on the sheet (new) or on frontmatter (legacy).
  const playerRaw =
    (typeof fm.player === 'string' ? fm.player : null) ??
    (typeof sheet.player === 'string' ? (sheet.player as string) : null);
  const playerUserId =
    role === 'pc' && playerRaw ? resolvePlayerUserId(playerRaw) : null;

  const campaignsExplicit = Array.isArray(fm.campaigns)
    ? fm.campaigns.filter((c): c is string => typeof c === 'string').map(slugify)
    : [];
  const campaignsEffective =
    campaignsExplicit.length > 0
      ? campaignsExplicit
      : [extractCampaignSlugFromPath(opts.notePath)].filter(
          (c): c is string => c !== null,
        );

  const now = Date.now();
  db.transaction(() => {
    db.query(
      `INSERT INTO characters
         (group_id, note_path, kind, player_user_id, display_name,
          portrait_path, level, class, race, ac, hp_max, hp_current,
          hp_temporary, proficiency_bonus, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (group_id, note_path) DO UPDATE SET
         kind              = excluded.kind,
         player_user_id    = excluded.player_user_id,
         display_name      = excluded.display_name,
         portrait_path     = excluded.portrait_path,
         level             = excluded.level,
         class             = excluded.class,
         race              = excluded.race,
         ac                = excluded.ac,
         hp_max            = excluded.hp_max,
         hp_current        = excluded.hp_current,
         hp_temporary      = excluded.hp_temporary,
         proficiency_bonus = excluded.proficiency_bonus,
         updated_at        = excluded.updated_at`,
    ).run(
      opts.groupId,
      opts.notePath,
      role,
      playerUserId,
      displayName,
      portraitPath,
      level,
      klass,
      race,
      ac,
      hpMax,
      hpCurrent,
      hpTemporary,
      proficiencyBonus,
      now,
    );

    db.query(
      'DELETE FROM character_campaigns WHERE group_id = ? AND note_path = ?',
    ).run(opts.groupId, opts.notePath);
    const insertCc = db.query(
      `INSERT OR IGNORE INTO character_campaigns
         (group_id, note_path, campaign_slug)
       VALUES (?, ?, ?)`,
    );
    for (const slug of campaignsEffective) {
      insertCc.run(opts.groupId, opts.notePath, slug);
    }
  })();
}

/** Ensure a campaigns row exists for any `Campaigns/<slug>/…` path.
 *  Idempotent; safe to call from the derive pipeline on every save.
 *  Name defaults to the folder name; admins can rename later. */
export function ensureCampaignForPath(
  groupId: string,
  notePath: string,
): void {
  const folder = extractCampaignFolderPath(notePath);
  if (!folder) return;
  const slug = slugify(folder.split('/').pop() ?? '');
  if (!slug) return;
  const db = getDb();
  const existing = db
    .query<{ slug: string }, [string, string]>(
      'SELECT slug FROM campaigns WHERE group_id = ? AND slug = ?',
    )
    .get(groupId, slug);
  if (existing) return;
  const name = folder.split('/').pop() ?? slug;
  db.query(
    `INSERT INTO campaigns (group_id, slug, name, folder_path, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(groupId, slug, name, folder, Date.now());
}

// ── Reads ──────────────────────────────────────────────────────────────

export type CharacterListRow = {
  notePath: string;
  kind: CharacterKind;
  playerUserId: string | null;
  displayName: string;
  portraitPath: string | null;
  level: number | null;
  class: string | null;
  race: string | null;
  ac: number | null;
  hpMax: number | null;
  hpCurrent: number | null;
  hpTemporary: number | null;
  proficiencyBonus: number | null;
  campaigns: string[];
  updatedAt: number;
};

type CharacterDbRow = {
  note_path: string;
  kind: string;
  player_user_id: string | null;
  display_name: string;
  portrait_path: string | null;
  level: number | null;
  class: string | null;
  race: string | null;
  ac: number | null;
  hp_max: number | null;
  hp_current: number | null;
  hp_temporary: number | null;
  proficiency_bonus: number | null;
  updated_at: number;
};

function rowToListEntry(
  r: CharacterDbRow,
  campaigns: string[],
): CharacterListRow {
  return {
    notePath: r.note_path,
    kind: r.kind as CharacterKind,
    playerUserId: r.player_user_id,
    displayName: r.display_name,
    portraitPath: r.portrait_path,
    level: r.level,
    class: r.class,
    race: r.race,
    ac: r.ac,
    hpMax: r.hp_max,
    hpCurrent: r.hp_current,
    hpTemporary: r.hp_temporary,
    proficiencyBonus: r.proficiency_bonus,
    campaigns,
    updatedAt: r.updated_at,
  };
}

/** All characters in the group. Use for dashboards and pickers. */
export function listCharacters(
  groupId: string,
  filter?: { playerUserId?: string; kind?: CharacterKind },
): CharacterListRow[] {
  const db = getDb();
  const wheres: string[] = ['group_id = ?'];
  const args: string[] = [groupId];
  if (filter?.playerUserId) {
    wheres.push('player_user_id = ?');
    args.push(filter.playerUserId);
  }
  if (filter?.kind) {
    wheres.push('kind = ?');
    args.push(filter.kind);
  }
  const rows = db
    .query<CharacterDbRow, string[]>(
      `SELECT note_path, kind, player_user_id, display_name, portrait_path,
              level, class, race, ac, hp_max, hp_current, hp_temporary,
              proficiency_bonus, updated_at
         FROM characters
        WHERE ${wheres.join(' AND ')}
        ORDER BY display_name COLLATE NOCASE`,
    )
    .all(...args);
  if (rows.length === 0) return [];
  const campaignsByPath = new Map<string, string[]>();
  const ccRows = db
    .query<{ note_path: string; campaign_slug: string }, [string]>(
      `SELECT note_path, campaign_slug
         FROM character_campaigns
        WHERE group_id = ?`,
    )
    .all(groupId);
  for (const cc of ccRows) {
    const list = campaignsByPath.get(cc.note_path) ?? [];
    list.push(cc.campaign_slug);
    campaignsByPath.set(cc.note_path, list);
  }
  return rows.map((r) => rowToListEntry(r, campaignsByPath.get(r.note_path) ?? []));
}

/** Fast lookup of "what kind is the note at this path?" for the
 *  file-tree icon rail. Characters come from the characters table;
 *  sessions come from the sessions table. Anything not indexed
 *  returns no entry — the caller treats it as a plain note. */
export type NoteKind = CharacterKind | 'session';

export function listNoteKinds(groupId: string): Map<string, NoteKind> {
  const db = getDb();
  const out = new Map<string, NoteKind>();
  const chars = db
    .query<{ note_path: string; kind: string }, [string]>(
      'SELECT note_path, kind FROM characters WHERE group_id = ?',
    )
    .all(groupId);
  for (const r of chars) out.set(r.note_path, r.kind as CharacterKind);
  const sessions = db
    .query<{ note_path: string }, [string]>(
      'SELECT note_path FROM session_notes WHERE group_id = ?',
    )
    .all(groupId);
  for (const r of sessions) out.set(r.note_path, 'session');
  return out;
}

export type CampaignRow = {
  slug: string;
  name: string;
  folderPath: string;
};

export function listCampaigns(groupId: string): CampaignRow[] {
  return getDb()
    .query<
      { slug: string; name: string; folder_path: string },
      [string]
    >(
      `SELECT slug, name, folder_path
         FROM campaigns
        WHERE group_id = ?
        ORDER BY name COLLATE NOCASE`,
    )
    .all(groupId)
    .map((r) => ({ slug: r.slug, name: r.name, folderPath: r.folder_path }));
}

/** Resolve a campaign row by slug (case-insensitive). Slug is normalised
 *  the same way as `Campaigns/<segment>/` path derivation so UI + AI
 *  can pass either the stored slug or a human phrase that slugifies
 *  to the same key. */
export function getCampaignBySlug(
  groupId: string,
  rawSlug: string,
): CampaignRow | null {
  const slug = slugify(rawSlug.trim());
  if (!slug) return null;
  const row = getDb()
    .query<
      { slug: string; name: string; folder_path: string },
      [string, string]
    >(
      `SELECT slug, name, folder_path
         FROM campaigns
        WHERE group_id = ? AND lower(slug) = lower(?)`,
    )
    .get(groupId, slug);
  if (!row) return null;
  return { slug: row.slug, name: row.name, folderPath: row.folder_path };
}

// ── Permission helper ──────────────────────────────────────────────────

/** True when a viewer-role user owns this character via frontmatter
 *  `player:`. Used by the collab-server read-only gate to let a
 *  player edit their own PC. */
export function isPcOwnedBy(
  groupId: string,
  notePath: string,
  userId: string,
): boolean {
  const row = getDb()
    .query<{ player_user_id: string | null }, [string, string]>(
      `SELECT player_user_id FROM characters
         WHERE group_id = ? AND note_path = ?`,
    )
    .get(groupId, notePath);
  return !!row && row.player_user_id === userId;
}

// ── Helpers ────────────────────────────────────────────────────────────

function detectRole(fm: FrontmatterShape, path: string): CharacterKind {
  if (isCharacterKind(fm.role)) return fm.role;
  const p = path.toLowerCase();
  if (/(^|\/)(pcs|characters)\//.test(p)) return 'pc';
  if (/(^|\/)allies\//.test(p)) return 'ally';
  if (/(^|\/)(villains|enemies)\//.test(p)) return 'villain';
  if (/(^|\/)(npcs|people)\//.test(p)) return 'npc';
  // New model: kind:character without an explicit role is a PC.
  return 'pc';
}

function resolvePlayerUserId(username: string): string | null {
  const row = getDb()
    .query<{ id: string }, [string]>(
      'SELECT id FROM users WHERE username = ? COLLATE NOCASE',
    )
    .get(username.trim());
  return row?.id ?? null;
}

function extractCampaignFolderPath(notePath: string): string | null {
  const m = /^((?:[^/]+\/)?Campaigns\/[^/]+)(?:\/|$)/i.exec(notePath);
  return m ? m[1]! : null;
}

function extractCampaignSlugFromPath(notePath: string): string | null {
  const folder = extractCampaignFolderPath(notePath);
  if (!folder) return null;
  return slugify(folder.split('/').pop() ?? '');
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function filenameDisplayName(notePath: string): string {
  return (notePath.split('/').pop() ?? notePath).replace(/\.(md|canvas)$/i, '');
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/** New-shape sheet.classes is an array of `{ ref: { name }, level }`.
 *  We surface the first entry's level in the quick-read column. */
function extractPrimaryLevel(classes: unknown): number | null {
  if (!Array.isArray(classes) || classes.length === 0) return null;
  const first = classes[0] as { level?: unknown };
  return intOrNull(first?.level);
}

function extractPrimaryClassName(classes: unknown): string | null {
  if (!Array.isArray(classes) || classes.length === 0) return null;
  return extractRefName((classes[0] as { ref?: unknown })?.ref);
}

/** New-shape race is `{ ref: { name } }`. Returns the ref name or null. */
function extractRefName(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const ref = (v as { ref?: unknown }).ref ?? v;
  if (!ref || typeof ref !== 'object') return null;
  const name = (ref as { name?: unknown }).name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
}

function extractAc(sheet: Record<string, unknown>): number | null {
  const newShape = sheet.armor_class;
  if (newShape && typeof newShape === 'object') {
    const v = (newShape as { value?: unknown }).value;
    const n = intOrNull(v);
    if (n !== null) return n;
  }
  return intOrNull(sheet.ac);
}

function extractHp(
  sheet: Record<string, unknown>,
  key: 'max' | 'current' | 'temporary',
): number | null {
  const hp = sheet.hit_points;
  if (!hp || typeof hp !== 'object') return null;
  return intOrNull((hp as Record<string, unknown>)[key]);
}
