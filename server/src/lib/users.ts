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
              created_at, last_login_at
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
              u.accent_color, u.created_at, u.last_login_at, gm.role AS role
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
                          accent_color, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      username,
      input.email?.trim() || null,
      passwordHash,
      input.displayName.trim(),
      accentColor,
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
