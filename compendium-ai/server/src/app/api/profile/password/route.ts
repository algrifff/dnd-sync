// PATCH /api/profile/password — self-service password change. Requires
// the caller's current password (even for admins — no bypass) so a
// stolen session cookie alone can't hijack the account credentials.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession, verifyPassword } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { findUserByUsername, changeUserPassword } from '@/lib/users';

export const dynamic = 'force-dynamic';

const Body = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  if (parsed.currentPassword === parsed.newPassword) {
    return json({ error: 'same_password' }, 400);
  }

  // Pull the row again so we have the hash — the session object
  // deliberately doesn't carry it around.
  const user = findUserByUsername(session.username);
  if (!user) return json({ error: 'not_found' }, 404);

  const ok = await verifyPassword(parsed.currentPassword, user.passwordHash);
  if (!ok) return json({ error: 'wrong_password' }, 403);

  await changeUserPassword(
    session.userId,
    parsed.newPassword,
    session.userId,
    session.currentGroupId,
  );

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
