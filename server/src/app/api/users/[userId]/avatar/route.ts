// GET /api/users/:userId/avatar  — serve the stored avatar image.
//
// Auth: session-bound. We don't otherwise restrict visibility
// because avatars are shown on every peer's cursor anyway; any
// authenticated member of any group sharing a document sees
// everyone else's face.
//
// Caching: include the avatar_updated_at as ?v=<ts>. We send
// immutable cache headers keyed on the version so new uploads get
// picked up instantly (client bumps the query string).

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { loadUserAvatar } from '@/lib/users';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { userId } = await params;
  const avatar = loadUserAvatar(userId);
  if (!avatar) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(avatar.blob), {
    status: 200,
    headers: {
      'Content-Type': avatar.mime,
      // The client passes ?v=<updatedAt>; different uploads yield a
      // different URL and the browser treats them as distinct
      // resources, so we can cache aggressively on each version.
      'Cache-Control': 'private, max-age=604800, immutable',
    },
  });
}
