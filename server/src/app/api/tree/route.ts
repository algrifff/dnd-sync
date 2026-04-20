// GET /api/tree — folder tree for the current group.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { buildTree } from '@/lib/tree';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const tree = buildTree(session.currentGroupId);
  const etag = `"tree-${tree.updatedAt}"`;

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(JSON.stringify(tree), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ETag: etag,
      'Cache-Control': 'private, must-revalidate',
    },
  });
}
