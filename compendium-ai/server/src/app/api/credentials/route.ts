// GET /api/credentials — admin-only.
//
// Returns everything the dashboard needs to show a friend (or a DM
// helping them) the exact values to paste into plugin settings when
// an install script fails. Never cached.

import type { NextRequest } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { getConfigValue } from '@/lib/config';
import { listActiveFriendsWithTokens } from '@/lib/friends';

export const dynamic = 'force-dynamic';

function resolveServerUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  }
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  return Response.json({
    serverUrl: resolveServerUrl(req),
    installerKey: getConfigValue('installer_key'),
    shared: { playerToken: getConfigValue('player_token') },
    friends: listActiveFriendsWithTokens().map((f) => ({
      id: f.id,
      name: f.name,
      token: f.token,
      createdAt: f.createdAt,
    })),
  });
}
