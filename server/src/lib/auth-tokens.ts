// Password-reset + email-verification tokens.
//
// The raw token is generated here, handed back to the caller (who emails
// it), and immediately forgotten. Only sha256(token) is stored in the DB
// so a database leak can't be replayed as active reset / verify links.
// Tokens are single-use (via used_at / verified_at) and time-bound.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db';

const RESET_TTL_MS = 60 * 60_000;         // 1 hour
const VERIFY_TTL_MS = 24 * 60 * 60_000;   // 24 hours

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function newRawToken(): string {
  return randomBytes(32).toString('hex'); // 64 hex chars, 256 bits
}

// ── Password reset ─────────────────────────────────────────────────────

export type CreatedResetToken = { token: string; expiresAt: number };

export function createPasswordResetToken(userId: string, ip: string | null): CreatedResetToken {
  const token = newRawToken();
  const now = Date.now();
  const expiresAt = now + RESET_TTL_MS;

  getDb()
    .query(
      `INSERT INTO password_reset_tokens
         (id, user_id, token_hash, expires_at, used_at, created_at, ip)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), userId, hashToken(token), expiresAt, now, ip);

  return { token, expiresAt };
}

/** Validate and consume a reset token. Returns the user id on success,
 *  null if the token is unknown, expired, or already used. Marks the
 *  token used in the same transaction so it can't be replayed. */
export function consumePasswordResetToken(token: string): { userId: string } | null {
  const hash = hashToken(token);
  const db = getDb();
  const row = db
    .query<
      { id: string; user_id: string; expires_at: number; used_at: number | null },
      [string]
    >(
      `SELECT id, user_id, expires_at, used_at
         FROM password_reset_tokens WHERE token_hash = ?`,
    )
    .get(hash);

  if (!row) return null;
  if (row.used_at != null) return null;
  if (row.expires_at <= Date.now()) return null;

  db.query('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?').run(
    Date.now(),
    row.id,
  );
  return { userId: row.user_id };
}

// ── Email verification ─────────────────────────────────────────────────

export type CreatedVerifyToken = { token: string; expiresAt: number };

export function createEmailVerificationToken(userId: string): CreatedVerifyToken {
  const token = newRawToken();
  const now = Date.now();
  const expiresAt = now + VERIFY_TTL_MS;

  getDb()
    .query(
      `INSERT INTO email_verification_tokens
         (id, user_id, token_hash, expires_at, verified_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    )
    .run(randomUUID(), userId, hashToken(token), expiresAt, now);

  return { token, expiresAt };
}

export function consumeEmailVerificationToken(token: string): { userId: string } | null {
  const hash = hashToken(token);
  const db = getDb();
  const row = db
    .query<
      { id: string; user_id: string; expires_at: number; verified_at: number | null },
      [string]
    >(
      `SELECT id, user_id, expires_at, verified_at
         FROM email_verification_tokens WHERE token_hash = ?`,
    )
    .get(hash);

  if (!row) return null;
  if (row.verified_at != null) return null;
  if (row.expires_at <= Date.now()) return null;

  db.query('UPDATE email_verification_tokens SET verified_at = ? WHERE id = ?').run(
    Date.now(),
    row.id,
  );
  return { userId: row.user_id };
}

// ── Housekeeping ───────────────────────────────────────────────────────

/** Delete expired + used tokens older than a week. Called opportunistically
 *  on each create — a self-hosted instance doesn't need a cron for this. */
export function pruneExpiredAuthTokens(): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
  const db = getDb();
  db.query(
    'DELETE FROM password_reset_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)',
  ).run(cutoff, cutoff);
  db.query(
    'DELETE FROM email_verification_tokens WHERE expires_at < ? OR (verified_at IS NOT NULL AND verified_at < ?)',
  ).run(cutoff, cutoff);
}
