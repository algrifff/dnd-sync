import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import {
  claimSessionForProcessing,
  getSessionStatus,
  releaseSessionClaim,
} from './sessions';
import { setupTestDb, teardownTestDb } from './test-utils';

const GROUP_ID = 'test-group';

function seedGroup(id: string): void {
  getDb()
    .query(`INSERT OR IGNORE INTO groups (id, name, created_at) VALUES (?, ?, ?)`)
    .run(id, id, Date.now());
}

// session_notes has an FK on (group_id, note_path) -> notes(group_id, path),
// so a matching note row must exist first.
function seedSessionNote(groupId: string, path: string): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, content_json, updated_at)
       VALUES (?, ?, ?, '{}', ?)`,
    )
    .run(randomUUID(), groupId, path, Date.now());
}

// getSessionStatus()'s return type is the public SessionStatus contract
// (open/review/closed) and deliberately doesn't admit "processing" — read
// the raw column directly to assert that transient claim state.
function rawStatus(groupId: string, path: string): string | undefined {
  return getDb()
    .query<{ status: string }, [string, string]>(
      `SELECT status FROM session_notes WHERE group_id = ? AND note_path = ?`,
    )
    .get(groupId, path)?.status;
}

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM session_notes');
  db.exec('DELETE FROM notes');
  db.exec('DELETE FROM groups');
  seedGroup(GROUP_ID);
});

describe('claimSessionForProcessing', () => {
  it('should claim a session that has never been processed', () => {
    seedSessionNote(GROUP_ID, 'Campaigns/x/Sessions/1.md');

    const result = claimSessionForProcessing(GROUP_ID, 'Campaigns/x/Sessions/1.md', {
      force: false,
    });

    expect(result.claimed).toBe(true);
    if (result.claimed) expect(result.previousStatus).toBe('open');
    expect(rawStatus(GROUP_ID, 'Campaigns/x/Sessions/1.md')).toBe('processing');
  });

  it('should reject a second concurrent claim while the first is still processing', () => {
    const path = 'Campaigns/x/Sessions/2.md';
    seedSessionNote(GROUP_ID, path);

    const first = claimSessionForProcessing(GROUP_ID, path, { force: false });
    const second = claimSessionForProcessing(GROUP_ID, path, { force: false });

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.status).toBe('processing');
  });

  it('should reject claiming an already-closed session without force', () => {
    const path = 'Campaigns/x/Sessions/3.md';
    seedSessionNote(GROUP_ID, path);
    getDb()
      .query(
        `INSERT INTO session_notes (group_id, note_path, updated_at, status)
         VALUES (?, ?, ?, 'closed')`,
      )
      .run(GROUP_ID, path, Date.now());

    const result = claimSessionForProcessing(GROUP_ID, path, { force: false });

    expect(result.claimed).toBe(false);
    if (!result.claimed) expect(result.status).toBe('closed');
  });

  it('should allow re-claiming a closed session when force is set', () => {
    const path = 'Campaigns/x/Sessions/4.md';
    seedSessionNote(GROUP_ID, path);
    getDb()
      .query(
        `INSERT INTO session_notes (group_id, note_path, updated_at, status)
         VALUES (?, ?, ?, 'closed')`,
      )
      .run(GROUP_ID, path, Date.now());

    const result = claimSessionForProcessing(GROUP_ID, path, { force: true });

    expect(result.claimed).toBe(true);
    if (result.claimed) expect(result.previousStatus).toBe('closed');
  });

  it('should recover a stale "processing" claim left behind by a crashed run', () => {
    const path = 'Campaigns/x/Sessions/5.md';
    seedSessionNote(GROUP_ID, path);
    const longAgo = Date.now() - 60 * 60_000; // 1 hour ago, well past the stale window
    getDb()
      .query(
        `INSERT INTO session_notes (group_id, note_path, updated_at, status)
         VALUES (?, ?, ?, 'processing')`,
      )
      .run(GROUP_ID, path, longAgo);

    const result = claimSessionForProcessing(GROUP_ID, path, { force: false });

    expect(result.claimed).toBe(true);
  });

  it('should NOT recover a recent "processing" claim within the stale window', () => {
    const path = 'Campaigns/x/Sessions/6.md';
    seedSessionNote(GROUP_ID, path);
    const justNow = Date.now() - 1_000;
    getDb()
      .query(
        `INSERT INTO session_notes (group_id, note_path, updated_at, status)
         VALUES (?, ?, ?, 'processing')`,
      )
      .run(GROUP_ID, path, justNow);

    const result = claimSessionForProcessing(GROUP_ID, path, { force: false });

    expect(result.claimed).toBe(false);
  });
});

describe('releaseSessionClaim', () => {
  it('should revert a processing session back to a given status', () => {
    const path = 'Campaigns/x/Sessions/7.md';
    seedSessionNote(GROUP_ID, path);
    claimSessionForProcessing(GROUP_ID, path, { force: false });
    expect(rawStatus(GROUP_ID, path)).toBe('processing');

    releaseSessionClaim(GROUP_ID, path, 'open');

    expect(getSessionStatus(GROUP_ID, path)).toBe('open');
  });

  it('should allow a released session to be claimed again immediately', () => {
    const path = 'Campaigns/x/Sessions/8.md';
    seedSessionNote(GROUP_ID, path);
    claimSessionForProcessing(GROUP_ID, path, { force: false });
    releaseSessionClaim(GROUP_ID, path, 'open');

    const result = claimSessionForProcessing(GROUP_ID, path, { force: false });

    expect(result.claimed).toBe(true);
  });
});
