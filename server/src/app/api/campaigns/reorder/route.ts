// POST /api/campaigns/reorder — sibling reorder of campaign folders in
// the sidebar. Sets `campaigns.sort_order` so the next /api/tree GET
// reflects the new order. The sort_order column is spaced ×100 on
// backfill (migration 46) so most reorders rewrite a single row;
// when the gap between neighbours is too small to insert between we
// re-pack the whole group's ordinals in the same transaction.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const Body = z.object({
  slug: z.string().min(1).max(256),
  // null = drop at the end of the list.
  beforeSlug: z.string().min(1).max(256).nullable(),
});

type Row = { slug: string; folder_path: string; sort_order: number };

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot reorder campaigns' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const { slug, beforeSlug } = parsed;

  const db = getDb();
  const groupId = session.currentGroupId;

  const all = db
    .query<Row, [string]>(
      `SELECT slug, folder_path, sort_order FROM campaigns
        WHERE group_id = ? ORDER BY sort_order, name`,
    )
    .all(groupId);

  // Sidebar passes the raw folder name (e.g. "Campaign 3"), but rows in
  // `campaigns` are stored slugified ("campaign-3"). Resolve via canonical
  // slug first, then folder_path. Reorder writes campaigns.sort_order, so
  // without a campaigns row there's nothing to reorder — no third tier.
  const resolveSlug = (raw: string): string | null => {
    const slugified = slugify(raw);
    const bySlug = all.find((c) => c.slug === slugified);
    if (bySlug) return bySlug.slug;
    const byFolder = all.find((c) => c.folder_path === `Campaigns/${raw}`);
    return byFolder?.slug ?? null;
  };

  const canonicalSlug = resolveSlug(slug);
  if (!canonicalSlug) {
    return json({ error: 'not_found', reason: `campaign '${slug}' not in this world` }, 404);
  }
  let canonicalBeforeSlug: string | null = null;
  if (beforeSlug !== null) {
    canonicalBeforeSlug = resolveSlug(beforeSlug);
    if (!canonicalBeforeSlug) {
      return json(
        { error: 'not_found', reason: `target '${beforeSlug}' not in this world` },
        404,
      );
    }
  }
  if (canonicalSlug === canonicalBeforeSlug) return json({ ok: true });

  db.transaction(() => {
    // Working list with the moved campaign removed, then re-inserted
    // at the target position. The list-after view is the source of
    // truth — sort_order is just its persisted form.
    const without = all.filter((c) => c.slug !== canonicalSlug);
    let insertAt = without.length; // append by default
    if (canonicalBeforeSlug !== null) {
      const idx = without.findIndex((c) => c.slug === canonicalBeforeSlug);
      if (idx >= 0) insertAt = idx;
    }
    const after: Row[] = [
      ...without.slice(0, insertAt),
      { slug: canonicalSlug, folder_path: '', sort_order: 0 }, // placeholder, recomputed below
      ...without.slice(insertAt),
    ];

    // Try a midpoint insertion first — cheap path. Falls through to a
    // full re-pack when neighbours leave no integer room.
    const prev = insertAt > 0 ? after[insertAt - 1]! : null;
    const next = insertAt < after.length - 1 ? after[insertAt + 1]! : null;
    let target: number;
    if (prev && next) {
      target = Math.floor((prev.sort_order + next.sort_order) / 2);
    } else if (prev) {
      target = prev.sort_order + 100;
    } else if (next) {
      target = next.sort_order - 100;
    } else {
      target = 100;
    }
    const tooTight =
      (prev && Math.abs(target - prev.sort_order) < 1) ||
      (next && Math.abs(next.sort_order - target) < 1);

    if (tooTight) {
      // Re-pack everyone — preserves the new order, restores ×100
      // spacing for future single-row writes.
      after.forEach((row, i) => {
        const so = (i + 1) * 100;
        db.query(
          `UPDATE campaigns SET sort_order = ? WHERE group_id = ? AND slug = ?`,
        ).run(so, groupId, row.slug);
      });
    } else {
      db.query(
        `UPDATE campaigns SET sort_order = ? WHERE group_id = ? AND slug = ?`,
      ).run(target, groupId, canonicalSlug);
    }
  })();

  logAudit({
    action: 'campaign.reorder',
    actorId: session.userId,
    groupId,
    target: canonicalSlug,
    details: { beforeSlug: canonicalBeforeSlug },
  });

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
