// POST /api/dev/validate-sheet — ad-hoc Zod validation preview.
//
// Body: { kind: string, sheet: unknown }
// Returns the validateSheet() result so the playground page can show
// both the coerced/defaulted data AND any issues without needing to
// actually write a note.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { validateSheet } from '@/lib/validateSheet';

export const dynamic = 'force-dynamic';

const Body = z.object({
  kind: z.string().max(64),
  sheet: z.unknown(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'bad_body', reason: String(err) }, 400);
  }

  const res = validateSheet(body.kind, body.sheet);
  return json(res);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
