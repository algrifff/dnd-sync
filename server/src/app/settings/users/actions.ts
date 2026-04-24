'use server';

// Server Actions for the admin users page. Both actions are gated behind
// the super-admin cookie (__sa) — only accessible from /admin/users.

import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { CreateUserRequestSchema, UserRoleSchema } from '@compendium/shared';
import { isSuperAdmin } from '@/lib/superadmin';
import { logAudit } from '@/lib/audit';
import { createUser, clearAllData, DEFAULT_GROUP_ID, deleteUserWithContent, revokeUser, setMemberRole } from '@/lib/users';

export type CreateUserResult =
  | { ok: true; username: string; password: string; message: string }
  | { ok: false; error: string };

export type RevokeUserResult = { ok: boolean; error?: string };

async function requireSuperAdmin(): Promise<boolean> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return isSuperAdmin(cookieHeader);
}

function generatedPassword(): string {
  // 16 random bytes → 22-char base64url string.
  return randomBytes(16).toString('base64url');
}

export async function createUserAction(
  _prev: CreateUserResult | null,
  formData: FormData,
): Promise<CreateUserResult> {
  if (!(await requireSuperAdmin())) return { ok: false, error: 'forbidden' };

  const password = generatedPassword();
  const parsed = CreateUserRequestSchema.safeParse({
    username: String(formData.get('username') ?? '').trim(),
    displayName: String(formData.get('displayName') ?? '').trim(),
    password,
    role: UserRoleSchema.parse(formData.get('role') ?? 'viewer'),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? 'invalid user details' };
  }

  try {
    await createUser({
      username: parsed.data.username,
      displayName: parsed.data.displayName,
      password: parsed.data.password,
      role: parsed.data.role,
      groupId: DEFAULT_GROUP_ID,
      actorId: 'superadmin',
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'failed to create user',
    };
  }

  revalidatePath('/admin/users');

  return {
    ok: true,
    username: parsed.data.username,
    password,
    message: `Created ${parsed.data.username}. Share the password below — it will not be shown again.`,
  };
}

export async function revokeUserAction(userId: string): Promise<RevokeUserResult> {
  if (!(await requireSuperAdmin())) return { ok: false, error: 'forbidden' };
  const ok = revokeUser(userId, 'superadmin', DEFAULT_GROUP_ID);
  if (!ok) return { ok: false, error: 'user not found' };
  revalidatePath('/admin/users');
  return { ok: true };
}

export async function deleteUserWithContentAction(userId: string): Promise<RevokeUserResult> {
  if (!(await requireSuperAdmin())) return { ok: false, error: 'forbidden' };
  deleteUserWithContent(userId, 'superadmin');
  revalidatePath('/admin/users');
  return { ok: true };
}

export type SetRoleResult = { ok: true; role: 'admin' | 'editor' | 'viewer' } | { ok: false; error: string };

export async function setUserRoleAction(userId: string, role: unknown): Promise<SetRoleResult> {
  if (!(await requireSuperAdmin())) return { ok: false, error: 'forbidden' };
  const parsed = UserRoleSchema.safeParse(role);
  if (!parsed.success) return { ok: false, error: 'invalid_role' };

  const result = setMemberRole(DEFAULT_GROUP_ID, userId, parsed.data);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === 'would_orphan_admin'
          ? 'Cannot demote the last admin of this world.'
          : result.error === 'not_member'
            ? 'User is not a member of this world.'
            : 'Could not update role.',
    };
  }

  logAudit({
    action: 'group.member_role_changed',
    actorId: null,
    groupId: DEFAULT_GROUP_ID,
    target: userId,
    details: { role: parsed.data, actor: 'superadmin' },
  });

  revalidatePath('/admin/users');
  return { ok: true, role: parsed.data };
}

export async function clearDatabaseAction(): Promise<RevokeUserResult> {
  if (!(await requireSuperAdmin())) return { ok: false, error: 'forbidden' };
  clearAllData();
  revalidatePath('/admin/users');
  return { ok: true };
}
