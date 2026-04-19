// PATCH /api/profile — self-service profile edit. Lets any authed user
// change their display name or accent colour (hex from the fixed
// palette). Password change lives on /api/profile/password so it can
// take its own CSRF-protected request body with the current password.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { ACCENT_PALETTE, updateUserProfile } from '@/lib/users';

export const dynamic = 'force-dynamic';

const Body = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    accentColor: z
      .string()
      .refine((v) => (ACCENT_PALETTE as readonly string[]).includes(v), {
        message: 'accentColor must be one of the palette values',
      })
      .optional(),
  })
  .refine((o) => o.displayName !== undefined || o.accentColor !== undefined, {
    message: 'nothing to update',
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

  updateUserProfile(session.userId, parsed);

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
