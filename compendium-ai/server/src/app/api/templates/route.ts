// GET /api/templates — list every note template (admin + user facing).
//
// Templates are global, so any authed user can read them. Editing
// is admin-only and lives in /api/templates/[kind]/route.ts. Read
// access is needed by the character sheet UI (Phase 1d) to know
// what fields to render.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { listTemplates } from '@/lib/templates';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  return new Response(JSON.stringify({ templates: listTemplates() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
