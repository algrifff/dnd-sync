// PATCH /api/profile — self-service profile edit. Lets any authed user
// change their display name or accent colour (hex from the fixed
// palette). Password change lives on /api/profile/password so it can
// take its own CSRF-protected request body with the current password.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import {
  requireSession,
  buildThemeCookie,
  serialiseCookie,
} from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { updateUserProfile } from '@/lib/users';

export const dynamic = 'force-dynamic';

// Accent color can now be any #RRGGBB hex (or #RGB short form).
// Users pick either a preset swatch or a custom value from the
// native colour picker; both path through here.
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const Body = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    accentColor: z
      .string()
      .regex(HEX_COLOR, 'accentColor must be #RRGGBB or #RGB')
      .optional(),
    cursorMode: z.enum(['color', 'image']).optional(),
    // null clears the active character pin; undefined leaves it
    // untouched. Any string is accepted — we don't verify the path
    // exists so an admin can pre-set a character the user will
    // create in a future session.
    activeCharacterPath: z.string().min(1).max(512).nullable().optional(),
    theme: z.enum(['day', 'night']).optional(),
  })
  .refine(
    (o) =>
      o.displayName !== undefined ||
      o.accentColor !== undefined ||
      o.cursorMode !== undefined ||
      o.activeCharacterPath !== undefined ||
      o.theme !== undefined,
    { message: 'nothing to update' },
  );

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

  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (parsed.theme) {
    // Mirror to the readable cookie so the root layout can render
    // <html data-theme> without a session roundtrip on the next request.
    (headers as Record<string, string>)['Set-Cookie'] = serialiseCookie(
      buildThemeCookie(parsed.theme),
      { httpOnly: false },
    );
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
