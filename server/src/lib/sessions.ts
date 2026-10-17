// Session index derivation.
//
// A session note is any note whose frontmatter declares
// `kind: session`. The sessions table mirrors a subset of the
// session sheet (date / number / title / attendees) so /sessions
// can show a chronological list per campaign without scanning
// every note's JSON.
//
// Derivation mirrors the character pipeline (lib/characters.ts):
// on every note save we upsert or delete the row based on
// frontmatter. Campaign slug is inferred from the note's path when
// not explicit in frontmatter.

import { getDb } from './db';
import { slugify } from './slugify';

export type SessionStatus = 'open' | 'closed';

export function getSessionStatus(groupId: string, notePath: string): SessionStatus {
  const row = getDb()
    .query<{ status: string }, [string, string]>(
      `SELECT status FROM session_notes WHERE group_id=? AND note_path=?`,
    )
    .get(groupId, notePath);
  return row?.status === 'closed' ? 'closed' : 'open';
}

/** The pending Wrap-up proposal stored for a Session, as raw JSON
 *  text. `lib/wrap-up.ts` owns its shape. */
export function readPendingWrapUpJson(groupId: string, notePath: string): string | null {
  const row = getDb()
    .query<{ wrap_up_json: string | null }, [string, string]>(
      `SELECT wrap_up_json FROM session_notes WHERE group_id=? AND note_path=?`,
    )
    .get(groupId, notePath);
  return row?.wrap_up_json ?? null;
}

export function writePendingWrapUpJson(
  groupId: string,
  notePath: string,
  json: string | null,
): void {
  getDb()
    .query(
      `INSERT INTO session_notes (group_id, note_path, updated_at, wrap_up_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (group_id, note_path) DO UPDATE SET wrap_up_json = excluded.wrap_up_json`,
    )
    .run(groupId, notePath, Date.now(), json);
}

/** Marks the Session Closed and drops any pending proposal. Closing an
 *  already Closed Session only refreshes closed_at / closed_by. */
export function closeSession(groupId: string, notePath: string, closedBy: string): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO session_notes (group_id, note_path, updated_at, status, closed_at, closed_by, wrap_up_json)
       VALUES (?, ?, ?, 'closed', ?, ?, NULL)
       ON CONFLICT (group_id, note_path)
       DO UPDATE SET status='closed', closed_at=excluded.closed_at,
                     closed_by=excluded.closed_by, wrap_up_json=NULL`,
    )
    .run(groupId, notePath, now, now, closedBy);
}

export function deriveSessionFromFrontmatter(opts: {
  groupId: string;
  notePath: string;
  frontmatterJson: string;
}): void {
  const db = getDb();
  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(opts.frontmatterJson) as Record<string, unknown>;
  } catch {
    fm = {};
  }
  if (fm.kind !== 'session') {
    db.query(
      'DELETE FROM session_notes WHERE group_id = ? AND note_path = ?',
    ).run(opts.groupId, opts.notePath);
    return;
  }

  const sheet =
    fm.sheet && typeof fm.sheet === 'object'
      ? (fm.sheet as Record<string, unknown>)
      : {};
  const campaignSlug = resolveCampaignSlug(fm, opts.notePath);
  const sessionDate = strOrNull(sheet.date);
  const sessionNumber = intOrNull(sheet.session_number);
  const title = strOrNull(sheet.title);
  const attendees = Array.isArray(sheet.attendees)
    ? sheet.attendees.filter((v): v is string => typeof v === 'string')
    : [];

  db.query(
    `INSERT INTO session_notes
       (group_id, note_path, campaign_slug, session_date, session_number,
        title, attendees_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (group_id, note_path) DO UPDATE SET
       campaign_slug  = excluded.campaign_slug,
       session_date   = excluded.session_date,
       session_number = excluded.session_number,
       title          = excluded.title,
       attendees_json = excluded.attendees_json,
       updated_at     = excluded.updated_at`,
  ).run(
    opts.groupId,
    opts.notePath,
    campaignSlug,
    sessionDate,
    sessionNumber,
    title,
    JSON.stringify(attendees),
    Date.now(),
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

export function resolveCampaignSlug(
  fm: Record<string, unknown>,
  notePath: string,
): string | null {
  if (Array.isArray(fm.campaigns)) {
    const first = fm.campaigns.find((c): c is string => typeof c === 'string');
    if (first) return slugify(first);
  }
  const m = /^(?:[^/]+\/)?Campaigns\/([^/]+)(?:\/|$)/i.exec(notePath);
  return m ? slugify(m[1]!) : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}
