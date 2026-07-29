// Append-only audit log for admin + sync operations. Every admin
// mutation (user created/revoked, vault uploaded, note destroyed,
// session rotated after login) writes one row here so we can answer
// "who did what when" after the fact.
//
// `details` is a free-form object serialised to JSON — keep it non-PII.

import { randomUUID } from 'node:crypto';
import { getDb } from './db';

export type AuditAction =
  | 'user.create'
  | 'user.revoke'
  | 'user.login'
  | 'user.logout'
  | 'user.passwordChange'
  | 'user.signup'
  | 'user.passwordReset'
  | 'user.passwordResetRequested'
  | 'user.emailVerified'
  | 'vault.upload'
  | 'asset.upload'
  | 'asset.delete'
  | 'note.create'
  | 'note.destroy'
  | 'note.rename'
  | 'note.move'
  | 'note.tags_update'
  | 'folder.create'
  | 'folder.rename'
  | 'folder.destroy'
  | 'session.rotate'
  | 'group.create'
  | 'group.delete'
  | 'group.join'
  | 'group.switch'
  | 'group.settings_update'
  | 'group.transfer_ownership'
  | 'group.member_role_changed'
  | 'personality.create'
  | 'personality.update'
  | 'personality.delete'
  | 'world.icon.upload'
  | 'world.icon.clear'
  | 'user.deleteWithContent'
  | 'db.wipe'
  | 'character.assign_player'
  | 'campaign.reorder'
  | 'campaign.destroy';

export type AuditEntry = {
  action: AuditAction;
  actorId: string | null;
  groupId: string;
  target?: string | null;
  details?: Record<string, unknown>;
};

/** Write one audit row. Best-effort — a failure here must not block the
 *  caller's happy path. We log but do not throw. */
export function logAudit(entry: AuditEntry): void {
  try {
    getDb()
      .query(
        `INSERT INTO audit_log (id, group_id, actor_id, action, target, details_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        entry.groupId,
        entry.actorId,
        entry.action,
        entry.target ?? null,
        JSON.stringify(entry.details ?? {}),
        Date.now(),
      );
  } catch (err) {
    console.warn('[audit] failed to write:', err instanceof Error ? err.message : String(err));
  }
}

export type AuditRow = {
  id: string;
  group_id: string;
  actor_id: string | null;
  action: AuditAction;
  target: string | null;
  details_json: string;
  at: number;
};

/** Most recent N entries for the admin dashboard. */
export function recentAudit(groupId: string, limit = 50): AuditRow[] {
  return getDb()
    .query<AuditRow, [string, number]>(
      `SELECT id, group_id, actor_id, action, target, details_json, at
         FROM audit_log
         WHERE group_id = ?
         ORDER BY at DESC
         LIMIT ?`,
    )
    .all(groupId, Math.max(1, Math.min(limit, 500)));
}

// ── Retention ──────────────────────────────────────────────────────────

// `audit_log` is append-only and has no other pruning path (the only
// existing `DELETE FROM audit_log` fires when a whole group is deleted,
// in lib/groups.ts). Left alone it grows forever — every login/logout
// and every admin mutation adds a row. There is no other reader of this
// table today (recentAudit() above is the only query site; no admin UI,
// export, or compliance surface consumes it yet), so a fixed window is
// safe to choose on operational grounds alone.
//
// Default: 180 days. That's long enough to cover any plausible "who did
// this last quarter" investigation on a self-hosted single-tenant app,
// short enough to keep the table from growing unbounded on a
// long-lived instance. Configurable via AUDIT_LOG_RETENTION_DAYS for
// operators who want a shorter/longer window.
const DEFAULT_AUDIT_RETENTION_DAYS = 180;

function auditRetentionMs(): number {
  const raw = process.env.AUDIT_LOG_RETENTION_DAYS;
  const days = raw ? Number(raw) : DEFAULT_AUDIT_RETENTION_DAYS;
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_AUDIT_RETENTION_DAYS;
  return safeDays * 24 * 60 * 60_000;
}

/** Delete audit rows older than the retention window. Returns the number
 *  of rows removed. Safe to call opportunistically (on boot) or on a
 *  recurring interval — it's a single indexed DELETE keyed on `at`. */
export function pruneExpiredAuditLog(): number {
  const cutoff = Date.now() - auditRetentionMs();
  const res = getDb().query('DELETE FROM audit_log WHERE at < ?').run(cutoff);
  return Number(res.changes);
}
