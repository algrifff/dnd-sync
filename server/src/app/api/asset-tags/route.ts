// PATCH /api/asset-tags — replace the tag set for a single asset.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { getAssetById } from '@/lib/assets';

export const dynamic = 'force-dynamic';

const TagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_\-/]+$/, 'tags must be alphanumeric plus _-/');

const Body = z.object({
  assetId: z.string().min(1).max(64),
  tags: z.array(TagSchema).max(64),
});

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot edit tags' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const asset = getAssetById(body.assetId, session.currentGroupId);
  if (!asset) return json({ error: 'not_found' }, 404);

  const normalised = [...new Set(body.tags.map((t) => t.replace(/^#/, '').toLowerCase()))];

  const db = getDb();
  db.transaction(() => {
    db.query('DELETE FROM asset_tags WHERE group_id = ? AND asset_id = ?').run(
      session.currentGroupId,
      body.assetId,
    );
    const insertTag = db.query(
      'INSERT OR IGNORE INTO asset_tags (group_id, asset_id, tag) VALUES (?, ?, ?)',
    );
    for (const tag of normalised) insertTag.run(session.currentGroupId, body.assetId, tag);
  })();

  return json({ ok: true, tags: normalised });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
