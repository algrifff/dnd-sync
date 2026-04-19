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
  const level = intOrNull(sheet.level);
  const klass = strOrNull(sheet.class);
  const race = strOrNull(sheet.race);
  const portraitPath = strOrNull(fm.portrait);

  const playerUserId =
    role === 'pc' && typeof fm.player === 'string'
      ? resolvePlayerUserId(fm.player)
      : null;

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
          portrait_path, level, class, race, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (group_id, note_path) DO UPDATE SET
         kind           = excluded.kind,
         player_user_id = excluded.player_user_id,
         display_name   = excluded.display_name,
         portrait_path  = excluded.portrait_path,
         level          = excluded.level,
         class          = excluded.class,
         race           = excluded.race,
         updated_at     = excluded.updated_at`,
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
  if (/(^|\/)pcs\//.test(p)) return 'pc';
  if (/(^|\/)allies\//.test(p)) return 'ally';
  if (/(^|\/)villains\//.test(p)) return 'villain';
  if (/(^|\/)npcs\//.test(p)) return 'npc';
  return 'npc';
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
