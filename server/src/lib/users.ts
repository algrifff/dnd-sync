// User CRUD. Storage is the `users` table (global identity) plus
// `group_members` (per-group role). v1 has one hard-coded group called
// `default`; the model is already tenant-aware so multi-group only
// needs UI work later, not a schema migration.

import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db';
import { hashPassword, type UserRole } from './session';
import { logAudit } from './audit';

export const DEFAULT_GROUP_ID = 'default';

/** Ordered palette used to auto-assign cursor / pointer colours on user
 *  creation. Kept small so each friend has a distinct shade. */
export const ACCENT_PALETTE = [
  '#D4A85A', // candlelight
  '#7B8A5F', // moss
  '#8B4A52', // wine
  '#6B7F8E', // sage
  '#B5572A', // embers
  '#6A5D8B', // wisteria
] as const;

export type User = {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  accentColor: string;
  createdAt: number;
  lastLoginAt: number | null;
  emailVerifiedAt: number | null;
};

export type UserWithRole = User & {
  role: UserRole;
};

export type CreateUserInput = {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
  email?: string;
  groupId?: string; // defaults to DEFAULT_GROUP_ID
  actorId?: string | null;
};

type UserRow = {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  display_name: string;
  accent_color: string;
  created_at: number;
  last_login_at: number | null;
  email_verified_at: number | null;
};

type UserJoinRow = UserRow & { role: UserRole | null };

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    email: r.email,
    displayName: r.display_name,
    accentColor: r.accent_color,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    emailVerifiedAt: r.email_verified_at,
  };
}

function rowToUserWithRole(r: UserJoinRow): UserWithRole {
  return { ...rowToUser(r), role: (r.role ?? 'viewer') as UserRole };
}

// ── Reads ──────────────────────────────────────────────────────────────

export function findUserByUsername(username: string): (User & { passwordHash: string }) | null {
  const row = getDb()
    .query<UserRow, [string]>(
      `SELECT id, username, email, password_hash, display_name, accent_color,
              created_at, last_login_at, email_verified_at
         FROM users WHERE username = ? COLLATE NOCASE`,
    )
    .get(username);
  if (!row) return null;
  return { ...rowToUser(row), passwordHash: row.password_hash };
}

export function listUsersInGroup(groupId: string): UserWithRole[] {
  return getDb()
    .query<UserJoinRow, [string]>(
      `SELECT u.id, u.username, u.email, u.password_hash, u.display_name,
              u.accent_color, u.created_at, u.last_login_at,
              u.email_verified_at, gm.role AS role
         FROM users u
         JOIN group_members gm ON gm.user_id = u.id
        WHERE gm.group_id = ?
        ORDER BY u.created_at ASC`,
    )
    .all(groupId)
    .map(rowToUserWithRole);
}

export function countUsers(): number {
  const row = getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get();
  return row?.n ?? 0;
}

export type UserStorageStats = {
  userId: string;
  notesBytes: number;
  assetsBytes: number;
  avatarBytes: number;
  totalBytes: number;
};

export function getUserStorageStats(): UserStorageStats[] {
  const db = getDb();
  const rows = db
    .query<
      { user_id: string; notes_bytes: number; assets_bytes: number; avatar_bytes: number },
      []
    >(
      `SELECT
         u.id AS user_id,
         COALESCE((SELECT SUM(n.byte_size) FROM notes n WHERE n.created_by = u.id), 0) AS notes_bytes,
         COALESCE((SELECT SUM(a.size)      FROM assets a WHERE a.uploaded_by = u.id), 0) AS assets_bytes,
         COALESCE(LENGTH(u.avatar_blob), 0) AS avatar_bytes
       FROM users u`,
    )
    .all();
  return rows.map((r) => ({
    userId: r.user_id,
    notesBytes: r.notes_bytes,
    assetsBytes: r.assets_bytes,
    avatarBytes: r.avatar_bytes,
    totalBytes: r.notes_bytes + r.assets_bytes + r.avatar_bytes,
  }));
}

/** Delete a user and all worlds (groups) where they are the sole admin.
 *  The group CASCADE wipes all notes, assets, characters, etc. in those worlds.
 *  Notes in shared worlds remain; sessions/memberships cascade from the user row. */
export function deleteUserWithContent(userId: string, actorId: string): boolean {
  const db = getDb();

  // Find groups where this user is the only admin.
  const soloAdminGroups = db
    .query<{ group_id: string }, [string]>(
      `SELECT gm.group_id
         FROM group_members gm
        WHERE gm.user_id = ? AND gm.role = 'admin'
          AND (SELECT COUNT(*) FROM group_members gm2
               WHERE gm2.group_id = gm.group_id AND gm2.role = 'admin') = 1`,
    )
    .all(userId);

  db.transaction(() => {
    for (const { group_id } of soloAdminGroups) {
      db.query('DELETE FROM groups WHERE id = ?').run(group_id);
    }
    db.query('DELETE FROM users WHERE id = ?').run(userId);
  })();

  logAudit({
    action: 'user.deleteWithContent',
    actorId,
    groupId: DEFAULT_GROUP_ID,
    target: userId,
    details: { worldsDeleted: soloAdminGroups.map((g) => g.group_id) },
  });

  return true;
}

/** Wipe all user-generated content — users, sessions, notes, assets, worlds
 *  (except the default group shell and config). On next boot, ensureDefaultAdmin
 *  will re-seed the admin account. Intended for testing only. */
export function clearAllData(): void {
  const db = getDb();
  db.transaction(() => {
    // Wipe content tables first to respect FK order.
    for (const table of [
      'import_jobs',
      'group_invite_tokens',
      'asset_tags',
      'session_notes',
      'character_campaigns',
      'characters',
      'campaigns',
      'note_links',
      'tags',
      'aliases',
      'folder_markers',
      'graph_groups',
      'assets',
      'notes',
      'audit_log',
      'sessions',
      'group_members',
      'users',
    ]) {
      db.query(`DELETE FROM ${table}`).run();
    }
    // Keep the default group so sessions still have a valid current_group_id.
    // Delete any extra worlds created during testing.
    db.query(`DELETE FROM groups WHERE id != 'default'`).run();
  })();
}

// ── Writes ─────────────────────────────────────────────────────────────

export async function createUser(input: CreateUserInput): Promise<User> {
  const username = input.username.trim();
  if (!/^[a-z0-9_-]{3,32}$/i.test(username)) {
    throw new Error('username must be 3–32 chars, [a-z0-9_-]');
  }
  if (input.password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }

  const existing = findUserByUsername(username);
  if (existing) throw new Error(`username already exists: ${username}`);

  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);
  const now = Date.now();
  const groupId = input.groupId ?? DEFAULT_GROUP_ID;
  const accentColor = pickAccentColor();

  const db = getDb();
  db.transaction(() => {
    db.query(
      `INSERT INTO users (id, username, email, password_hash, display_name,
                          accent_color, created_at, last_login_at,
                          email_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      username,
      input.email?.trim() || null,
      passwordHash,
      input.displayName.trim(),
      accentColor,
      now,
      // Admin-created users are trusted; they skip email verification so
      // existing invite/creation flows aren't blocked by the new gate.
      now,
    );

    db.query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)`,
    ).run(groupId, id, input.role, now);
  })();

  logAudit({
    action: 'user.create',
    actorId: input.actorId ?? null,
    groupId,
    target: username,
    details: { role: input.role },
  });

  return {
    id,
    username,
    email: input.email ?? null,
    displayName: input.displayName,
    accentColor,
    createdAt: now,
    lastLoginAt: null,
    emailVerifiedAt: now,
  };
}

/** Self-service profile update: display name, accent color, cursor
 *  mode. Callers enforce auth/ownership. No audit entry — these are
 *  presentation tweaks and show up in the session row immediately. */
export function updateUserProfile(
  userId: string,
  patch: {
    displayName?: string | undefined;
    accentColor?: string | undefined;
    cursorMode?: 'color' | 'image' | undefined;
    activeCharacterPath?: string | null | undefined;
  },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (typeof patch.displayName === 'string') {
    sets.push('display_name = ?');
    values.push(patch.displayName);
  }
  if (typeof patch.accentColor === 'string') {
    sets.push('accent_color = ?');
    values.push(patch.accentColor);
  }
  if (patch.cursorMode === 'color' || patch.cursorMode === 'image') {
    sets.push('cursor_mode = ?');
    values.push(patch.cursorMode);
  }
  if (patch.activeCharacterPath !== undefined) {
    sets.push('active_character_path = ?');
    values.push(patch.activeCharacterPath);
  }
  if (sets.length === 0) return;
  values.push(userId);
  getDb()
    .query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

/** Overwrite the user's avatar. `blob` is already sized/compressed
 *  client-side before reaching this function (see the profile form
 *  uploader). avatar_updated_at doubles as a cache-buster for the
 *  public serve endpoint — peer cursors include it in their img URL. */
export function setUserAvatar(
  userId: string,
  blob: Uint8Array,
  mime: string,
): number {
  const now = Date.now();
  getDb()
    .query(
      `UPDATE users SET avatar_blob = ?, avatar_mime = ?, avatar_updated_at = ?
         WHERE id = ?`,
    )
    .run(blob, mime, now, userId);
  return now;
}

export function clearUserAvatar(userId: string): void {
  getDb()
    .query(
      `UPDATE users SET avatar_blob = NULL, avatar_mime = NULL,
                        avatar_updated_at = 0
         WHERE id = ?`,
    )
    .run(userId);
}

export function loadUserAvatar(
  userId: string,
): { blob: Uint8Array; mime: string; updatedAt: number } | null {
  const row = getDb()
    .query<
      {
        avatar_blob: Uint8Array | null;
        avatar_mime: string | null;
        avatar_updated_at: number;
      },
      [string]
    >(
      `SELECT avatar_blob, avatar_mime, avatar_updated_at
         FROM users WHERE id = ?`,
    )
    .get(userId);
  if (!row || !row.avatar_blob || !row.avatar_mime) return null;
  return {
    blob: new Uint8Array(row.avatar_blob),
    mime: row.avatar_mime,
    updatedAt: row.avatar_updated_at,
  };
}

export async function changeUserPassword(
  userId: string,
  plain: string,
  actorId: string,
  groupId: string,
): Promise<void> {
  if (plain.length < 8) throw new Error('password must be at least 8 characters');
  const hash = await hashPassword(plain);
  getDb().query('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  logAudit({
    action: 'user.passwordChange',
    actorId,
    groupId,
    target: userId,
  });
}

export function revokeUser(userId: string, actorId: string, groupId: string): boolean {
  const res = getDb().query('DELETE FROM users WHERE id = ?').run(userId);
  const revoked = Number(res.changes) > 0;
  if (revoked) {
    logAudit({
      action: 'user.revoke',
      actorId,
      groupId,
      target: userId,
    });
  }
  return revoked;
}

// ── Public signup + reset + verify ─────────────────────────────────────

/** Find a user by email address. Returns null if unknown. Case-insensitive
 *  match (email column has COLLATE NOCASE). Used by the forgot-password
 *  flow; callers must NOT leak existence to the client. */
export function findUserByEmail(email: string): User | null {
  const row = getDb()
    .query<UserRow, [string]>(
      `SELECT id, username, email, password_hash, display_name, accent_color,
              created_at, last_login_at, email_verified_at
         FROM users WHERE email = ? COLLATE NOCASE`,
    )
    .get(email.trim());
  return row ? rowToUser(row) : null;
}

export type SignupUserInput = {
  username: string;
  email: string;
  password: string;
  groupId?: string;
};

/** Self-service signup. Unlike `createUser` this requires email and leaves
 *  `email_verified_at = NULL` so `loginAction` blocks the account until the
 *  user clicks the verification link. */
export async function signupUser(input: SignupUserInput): Promise<User> {
  const username = input.username.trim();
  const email = input.email.trim().toLowerCase();

  if (!/^[a-z0-9_-]{3,32}$/i.test(username)) {
    throw new Error('username_invalid');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('email_invalid');
  }
  if (input.password.length < 8) {
    throw new Error('password_too_short');
  }
  if (findUserByUsername(username)) throw new Error('username_taken');
  if (findUserByEmail(email)) throw new Error('email_taken');

  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);
  const now = Date.now();
  const groupId = input.groupId ?? DEFAULT_GROUP_ID;
  const accentColor = pickAccentColor();

  const db = getDb();
  db.transaction(() => {
    db.query(
      `INSERT INTO users (id, username, email, password_hash, display_name,
                          accent_color, created_at, last_login_at,
                          email_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, username, email, passwordHash, username, accentColor, now);

    db.query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)`,
    ).run(groupId, id, 'editor', now);
  })();

  logAudit({
    action: 'user.signup',
    actorId: null,
    groupId,
    target: username,
    details: { email },
  });

  return {
    id,
    username,
    email,
    displayName: username,
    accentColor,
    createdAt: now,
    lastLoginAt: null,
    emailVerifiedAt: null,
  };
}

/** Change a member's role within a specific world. Returns false if the
 *  target isn't a member of the group, or if the change would leave the
 *  world with zero admins. */
export function setMemberRole(
  groupId: string,
  userId: string,
  role: UserRole,
): { ok: true } | { ok: false; error: 'not_member' | 'would_orphan_admin' } {
  const db = getDb();
  const current = db
    .query<{ role: UserRole }, [string, string]>(
      'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    )
    .get(groupId, userId);
  if (!current) return { ok: false, error: 'not_member' };
  if (current.role === role) return { ok: true };

  if (current.role === 'admin' && role !== 'admin') {
    const remaining = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND role = 'admin'`,
      )
      .get(groupId);
    if ((remaining?.n ?? 0) <= 1) return { ok: false, error: 'would_orphan_admin' };
  }

  db.query(
    'UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?',
  ).run(role, groupId, userId);
  return { ok: true };
}

/** Mark a user's email as verified. Idempotent — safe to call twice. */
export function markEmailVerified(userId: string): void {
  getDb()
    .query('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL')
    .run(Date.now(), userId);
}

/** Reset a user's password via the forgot-password flow. Rotates the
 *  password hash, invalidates every active session for the user, and
 *  clears any outstanding reset tokens. Audits the action with no actor
 *  id (the "actor" is whoever clicked the emailed link). */
export async function changePasswordByReset(userId: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new Error('password_too_short');
  const hash = await hashPassword(newPassword);

  const db = getDb();
  db.transaction(() => {
    db.query('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    db.query('DELETE FROM sessions WHERE user_id = ?').run(userId);
    // Invalidate any other outstanding reset tokens for this user so the
    // same token can't be replayed and a lingering link can't be used.
    db.query(
      'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
    ).run(Date.now(), userId);
  })();

  logAudit({
    action: 'user.passwordReset',
    actorId: null,
    groupId: DEFAULT_GROUP_ID,
    target: userId,
  });
}

// ── Accent colour assignment ───────────────────────────────────────────

function pickAccentColor(): string {
  const row = getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get();
  const n = row?.n ?? 0;
  return ACCENT_PALETTE[n % ACCENT_PALETTE.length] ?? ACCENT_PALETTE[0];
}

// ── Admin seed on first boot ───────────────────────────────────────────

/** Generate a 24-char hex password string (96 bits of entropy — enough
 *  for a one-time admin seed the operator copies out of the boot log). */
function generateSeedPassword(): string {
  return randomBytes(12).toString('hex');
}

/** Create the default admin user on an empty DB. Returns the generated
 *  plaintext password if we created one so the caller can print it.
 *  Idempotent — no-op if any users already exist. */
export async function ensureDefaultAdmin(): Promise<
  { created: true; password: string; username: string } | { created: false }
> {
  if (countUsers() > 0) return { created: false };

  const username = 'admin';
  const password = generateSeedPassword();
  await createUser({
    username,
    displayName: 'Admin',
    password,
    role: 'admin',
    groupId: DEFAULT_GROUP_ID,
    actorId: null,
  });

  return { created: true, password, username };
}

export type AdminSeedResult = Awaited<ReturnType<typeof ensureDefaultAdmin>>;

/** Pretty-print the admin password banner — matches the existing
 *  `ensureConfig` style so the DM finds it in Railway logs. */
export function printAdminBanner(seed: AdminSeedResult): void {
  if (!seed.created) return;
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  Compendium web-app first-time setup');
  console.log('');
  console.log('  Admin login for the web dashboard:');
  console.log(`    username: ${seed.username}`);
  console.log(`    password: ${seed.password}`);
  console.log('');
  console.log('  Save this — you will not see it again. Change it from the');
  console.log('  admin user settings after you log in.');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('');
}
