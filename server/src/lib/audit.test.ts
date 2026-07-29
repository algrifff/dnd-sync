import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getDb } from './db';
import { logAudit, pruneExpiredAuditLog, recentAudit } from './audit';
import { DEFAULT_GROUP_ID } from './users';
import { setupTestDb, teardownTestDb } from './test-utils';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  getDb().exec('DELETE FROM audit_log');
});

describe('logAudit / recentAudit', () => {
  it('writes a row that recentAudit can read back', () => {
    logAudit({ action: 'user.login', actorId: null, groupId: DEFAULT_GROUP_ID });
    const rows = recentAudit(DEFAULT_GROUP_ID, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe('user.login');
  });
});

describe('pruneExpiredAuditLog', () => {
  it('deletes rows older than the retention window and keeps recent ones', () => {
    const db = getDb();
    logAudit({ action: 'user.login', actorId: null, groupId: DEFAULT_GROUP_ID, target: 'old' });
    logAudit({ action: 'user.login', actorId: null, groupId: DEFAULT_GROUP_ID, target: 'new' });

    const rows = db
      .query<{ id: string; target: string | null }, [string]>(
        'SELECT id, target FROM audit_log WHERE group_id = ? ORDER BY target',
      )
      .all(DEFAULT_GROUP_ID);
    expect(rows.length).toBe(2);

    // Backdate the "old" row to well past the default 180-day window.
    const staleAt = Date.now() - 200 * 24 * 60 * 60_000;
    const oldRow = rows.find((r) => r.target === 'old');
    db.query('UPDATE audit_log SET at = ? WHERE id = ?').run(staleAt, oldRow!.id);

    const removed = pruneExpiredAuditLog();
    expect(removed).toBe(1);

    const remaining = recentAudit(DEFAULT_GROUP_ID, 10);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.target).toBe('new');
  });

  it('respects AUDIT_LOG_RETENTION_DAYS when set', () => {
    const db = getDb();
    logAudit({ action: 'user.login', actorId: null, groupId: DEFAULT_GROUP_ID, target: 'recent-ish' });
    const row = db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM audit_log WHERE group_id = ? AND target = ?',
      )
      .get(DEFAULT_GROUP_ID, 'recent-ish');

    // 10 days old — survives the default 180-day window but not a
    // configured 1-day window.
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60_000;
    db.query('UPDATE audit_log SET at = ? WHERE id = ?').run(tenDaysAgo, row!.id);

    const prevEnv = process.env.AUDIT_LOG_RETENTION_DAYS;
    process.env.AUDIT_LOG_RETENTION_DAYS = '1';
    try {
      const removed = pruneExpiredAuditLog();
      expect(removed).toBe(1);
    } finally {
      if (prevEnv === undefined) delete process.env.AUDIT_LOG_RETENTION_DAYS;
      else process.env.AUDIT_LOG_RETENTION_DAYS = prevEnv;
    }
  });
});
