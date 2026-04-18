'use server';

// Server Actions for the admin users page. Both actions are
// admin-gated (explicit role check even though the /admin layout
// already blocked the render) and both write audit rows.

import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { CreateUserRequestSchema, UserRoleSchema } from '@compendium/shared';
import { readSession } from '@/lib/session';
import { createUser, DEFAULT_GROUP_ID, revokeUser } from '@/lib/users';

export type CreateUserResult =
  | { ok: true; username: string; password: string; message: string }
  | { ok: false; error: string };

export type RevokeUserResult = { ok: boolean; error?: string };

async function requireAdminSession(): Promise<string | Response> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) {
    return new Response('unauthorized', { status: 401 });
  }
  if (session.role !== 'admin') {
    return new Response('forbidden', { status: 403 });
  }
  return session.userId;
}

function generatedPassword(): string {
  // 16 random bytes → 22-char base64url string. Readable enough to
  // copy-paste, strong enough for the one-time seed.
  return randomBytes(16).toString('base64url');
}

export async function createUserAction(
  _prev: CreateUserResult | null,
  formData: FormData,
): Promise<CreateUserResult> {
  const actor = await requireAdminSession();
  if (actor instanceof Response) return { ok: false, error: 'forbidden' };

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
      actorId: actor,
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
  const actor = await requireAdminSession();
  if (actor instanceof Response) return { ok: false, error: 'forbidden' };
  if (userId === actor) {
    return { ok: false, error: 'cannot revoke your own account while signed in' };
  }
  const ok = revokeUser(userId, actor, DEFAULT_GROUP_ID);
  if (!ok) return { ok: false, error: 'user not found' };
  revalidatePath('/admin/users');
  return { ok: true };
}
