// GET /api/assets/list — lightweight image-only listing for the
// portrait picker. Returns the current session's world assets
// filtered to image mime types, most recent first.

import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { listGroupAssetsWithTags } from '@/lib/assets';
import { GM_MODE_COOKIE, treeModeFor } from '@/lib/gm-mode';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const limit = clamp(parseInt(url.searchParams.get('limit') ?? '50', 10), 1, 200);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();

  const jar = await cookies();
  const mode = treeModeFor(jar.get(GM_MODE_COOKIE)?.value, session.role);
  const all = listGroupAssetsWithTags(session.currentGroupId, { mode })
    .filter((a) => a.mime.startsWith('image/'));

  const filtered = q
    ? all.filter(
        (a) =>
          a.originalName.toLowerCase().includes(q) ||
          a.originalPath.toLowerCase().includes(q) ||
          a.tags.some((t) => t.toLowerCase().includes(q)),
      )
    : all;

  const sorted = filtered.slice().sort((a, b) => b.uploadedAt - a.uploadedAt);

  return new Response(
    JSON.stringify({
      ok: true,
      assets: sorted.slice(0, limit).map((a) => ({
        id: a.id,
        mime: a.mime,
        originalName: a.originalName,
        originalPath: a.originalPath,
        tags: a.tags,
      })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
