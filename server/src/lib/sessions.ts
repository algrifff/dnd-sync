// Session index derivation + listing.
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

export type SessionListRow = {
  notePath: string;
  campaignSlug: string | null;
  sessionDate: string | null;
  sessionNumber: number | null;
  title: string | null;
  attendees: string[];
  updatedAt: number;
};

type DbRow = {
  note_path: string;
  campaign_slug: string | null;
  session_date: string | null;
  session_number: number | null;
  title: string | null;
  attendees_json: string | null;
  updated_at: number;
};

function rowToSession(r: DbRow): SessionListRow {
  let attendees: string[] = [];
  if (r.attendees_json) {
    try {
      const parsed = JSON.parse(r.attendees_json) as unknown;
      if (Array.isArray(parsed)) {
        attendees = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      /* ignore */
    }
  }
  return {
    notePath: r.note_path,
    campaignSlug: r.campaign_slug,
    sessionDate: r.session_date,
    sessionNumber: r.session_number,
    title: r.title,
    attendees,
    updatedAt: r.updated_at,
  };
}

export type SessionStatus = 'open' | 'review' | 'closed';

export function getSessionStatus(groupId: string, notePath: string): SessionStatus {
  const row = getDb()
    .query<{ status: string }, [string, string]>(
      `SELECT status FROM session_notes WHERE group_id=? AND note_path=?`,
    )
    .get(groupId, notePath);
  return (row?.status as SessionStatus) ?? 'open';
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

export function listSessions(
  groupId: string,
  filter?: { campaignSlug?: string },
): SessionListRow[] {
  const db = getDb();
  const wheres: string[] = ['group_id = ?'];
  const args: string[] = [groupId];
  if (filter?.campaignSlug) {
    wheres.push('campaign_slug = ?');
    args.push(filter.campaignSlug);
  }
  return db
    .query<DbRow, string[]>(
      `SELECT note_path, campaign_slug, session_date, session_number,
              title, attendees_json, updated_at
         FROM session_notes
        WHERE ${wheres.join(' AND ')}
        ORDER BY COALESCE(session_date, '') DESC,
                 COALESCE(session_number, 0) DESC,
                 updated_at DESC`,
    )
    .all(...args)
    .map(rowToSession);
}

// ── Helpers ────────────────────────────────────────────────────────────

function resolveCampaignSlug(
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

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
