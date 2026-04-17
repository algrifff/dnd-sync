// Admin-only CRUD for per-friend tokens.
//
//   GET  /api/friends        → list (no tokens included)
//   POST /api/friends        → { name } → { id, name, token, ... }
//                              (token returned once at creation)

import type { NextRequest } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { createFriend, listFriends } from '@/lib/friends';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  return Response.json({ friends: listFriends() });
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  let body: { name?: unknown };
  try {
    body = (await req.json()) as { name?: unknown };
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return Response.json({ error: 'name required' }, { status: 400 });
  }

  const friend = createFriend(body.name);
  return Response.json(friend, { status: 201 });
}
