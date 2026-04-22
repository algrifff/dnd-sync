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
  | 'vault.upload'
  | 'asset.upload'
  | 'asset.delete'
  | 'note.create'
  | 'note.destroy'
  | 'note.rename'
  | 'folder.create'
  | 'folder.rename'
  | 'folder.destroy'
  | 'session.rotate'
  | 'group.create'
  | 'group.delete'
  | 'group.join'
  | 'group.switch'
  | 'group.transfer_ownership'
  | 'personality.create'
  | 'personality.update'
  | 'personality.delete'
  | 'world.icon.upload'
  | 'world.icon.clear'
  | 'user.deleteWithContent'
  | 'db.wipe';

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
