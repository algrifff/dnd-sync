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

// ── Atomic processing claim (api/sessions/end) ──────────────────────────
//
// /api/sessions/end runs a multi-step AI extraction pass (entity_search /
// entity_create / entity_edit_content / backlink_create) that takes many
// seconds, then marks the session closed. Without a claim, two concurrent
// POSTs (double-click, or a client retry after a slow response) both read
// status="open", both run the full pipeline, and both write duplicate
// entities/backlinks into the knowledge graph.
//
// `status` gets a third transient value here, "processing" — the column
// has no CHECK constraint (see migration v14/v17), so this needs no schema
// change. The claim below is intentionally a single UPSERT with a WHERE
// guard on the UPDATE arm: SQLite evaluates that guard atomically as part
// of the one statement, so two concurrent callers cannot both observe
// "claimable" and both win — exactly one caller's UPDATE actually changes
// the row (checked via `changes`). This holds even if the app ever became
// multi-process, unlike an in-process Map/mutex.

// How long a "processing" claim is honored before another caller may
// reclaim it as abandoned (crashed process, unhandled rejection, etc.).
// The extraction pipeline allows up to stepCountIs(20) tool-call steps and
// normally finishes in low tens of seconds; 5 minutes is a wide safety
// margin above that before a still-"processing" row is treated as stuck.
// (If a real extraction ever legitimately ran longer than this, a second
// caller could in principle reclaim and double-run — see the route for
// the mitigating revert-on-failure behavior that keeps failed attempts
// from lingering in "processing" until this timeout.)
const PROCESSING_STALE_MS = 5 * 60_000;

// "processing" is a real, transient value the status column can hold
// (see above) but is intentionally NOT part of the public SessionStatus
// type — that type is the UI/listing-facing contract (open/review/closed)
// used elsewhere (e.g. notes/[...path]/page.tsx). Callers of the claim
// functions below need to see "processing" honestly, hence this
// claim-local widening instead of adding it to SessionStatus itself.
export type SessionRowStatus = SessionStatus | 'processing';

export type SessionClaimResult =
  | { claimed: true; previousStatus: SessionRowStatus }
  | { claimed: false; status: SessionRowStatus };

export function claimSessionForProcessing(
  groupId: string,
  notePath: string,
  opts: { force: boolean; now?: number },
): SessionClaimResult {
  const db = getDb();
  const now = opts.now ?? Date.now();
  const staleBefore = now - PROCESSING_STALE_MS;

  // Informational only — NOT the correctness gate. Used solely to report
  // what the status was before the claim (so the route can revert to it
  // if the AI call subsequently fails). Even if this read is stale by the
  // time the UPSERT below runs, the UPSERT's own WHERE guard is what
  // actually decides pass/fail, so there is no real race here.
  const before = db
    .query<{ status: string }, [string, string]>(
      `SELECT status FROM session_notes WHERE group_id = ? AND note_path = ?`,
    )
    .get(groupId, notePath);
  const previousStatus: SessionRowStatus = (before?.status as SessionRowStatus) ?? 'open';

  const res = db
    .query(
      `INSERT INTO session_notes (group_id, note_path, updated_at, status)
       VALUES (?, ?, ?, 'processing')
       ON CONFLICT (group_id, note_path) DO UPDATE SET
         status = 'processing',
         updated_at = excluded.updated_at
       WHERE session_notes.status = 'open'
          OR (session_notes.status = 'processing' AND session_notes.updated_at < ?)
          OR (session_notes.status = 'closed' AND ? = 1)`,
    )
    .run(groupId, notePath, now, staleBefore, opts.force ? 1 : 0);

  if (res.changes > 0) return { claimed: true, previousStatus };

  const after = db
    .query<{ status: string }, [string, string]>(
      `SELECT status FROM session_notes WHERE group_id = ? AND note_path = ?`,
    )
    .get(groupId, notePath);
  return { claimed: false, status: (after?.status as SessionRowStatus) ?? 'open' };
}

/** Revert a claimed-but-failed session back to its pre-claim status
 *  (called from the AI-error path in api/sessions/end) so a failed
 *  attempt is immediately retryable instead of sitting in "processing"
 *  until PROCESSING_STALE_MS elapses. The row is guaranteed to exist by
 *  this point (claimSessionForProcessing always inserts/updates it). */
export function releaseSessionClaim(
  groupId: string,
  notePath: string,
  revertTo: SessionStatus,
): void {
  getDb()
    .query(
      `UPDATE session_notes SET status = ?, updated_at = ? WHERE group_id = ? AND note_path = ?`,
    )
    .run(revertTo, Date.now(), groupId, notePath);
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
