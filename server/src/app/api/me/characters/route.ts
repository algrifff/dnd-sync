// GET  /api/me/characters — list the session user's user-level characters.
// POST /api/me/characters — create a new user-level character.
//
// User-level characters live outside any world. They can be brought
// into a world's active campaign via the join endpoint, which creates
// a bound note that two-way-syncs with the master row.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import {
  createUserCharacter,
  listUserCharacters,
} from '@/lib/userCharacters';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\\0]+$/, 'name must not contain slashes or null bytes'),
  kind: z.enum(['character', 'person']).optional(),
  sheet: z.record(z.string(), z.unknown()).optional(),
  portraitUrl: z.string().max(2048).nullable().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const characters = listUserCharacters(session.userId);
  return json({ ok: true, characters }, 200);
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  try {
    const character = createUserCharacter(session.userId, {
      name: body.name,
      kind: body.kind,
      sheet: body.sheet,
      portraitUrl: body.portraitUrl ?? null,
    });
    return json({ ok: true, character }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'create failed';
    if (msg.startsWith('invalid_sheet')) {
      return json({ error: 'invalid_sheet', reason: msg }, 400);
    }
    console.error('[me/characters] create failed:', err);
    return json({ error: 'create_failed', reason: msg }, 500);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
