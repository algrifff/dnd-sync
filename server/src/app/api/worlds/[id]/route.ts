// PATCH /api/worlds/[id] — rename a world. Admin-only.
// DELETE /api/worlds/[id] — delete a world and all its data. Admin-only;
//   refuses if it is the caller's last world.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { deleteWorld, setWorldFeatures } from '@/lib/groups';
import { setActivePersonality } from '@/lib/ai/personalities';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  headerColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  // null (or the built-in sentinel) reverts to the default scribe voice;
  // any other string must be the id of a personality in this world.
  activePersonalityId: z.string().min(1).nullable().optional(),
  // null clears the pin; any string must be an existing campaign slug.
  activeCampaignSlug: z.string().min(1).nullable().optional(),
  features: z
    .object({
      excalidraw: z.boolean().optional(),
    })
    .optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const db = getDb();
  const role = db
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(session.userId, id);
  if (!role || role.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }

  if (
    body.name === undefined &&
    body.headerColor === undefined &&
    body.activePersonalityId === undefined &&
    body.activeCampaignSlug === undefined &&
    body.features === undefined
  ) {
    return json({ error: 'invalid_body', detail: 'Nothing to update' }, 400);
  }

  if (body.name !== undefined) {
    db.query('UPDATE groups SET name = ? WHERE id = ?').run(body.name, id);
  }
  if (body.headerColor !== undefined) {
    db.query('UPDATE groups SET header_color = ? WHERE id = ?').run(body.headerColor, id);
  }
  if (body.activePersonalityId !== undefined) {
    const ok = setActivePersonality(id, body.activePersonalityId);
    if (!ok) {
      return json(
        { error: 'not_found', detail: 'Unknown personality for this world.' },
        404,
      );
    }
  }
  if (body.activeCampaignSlug !== undefined) {
    let canonicalSlug: string | null = null;
    if (body.activeCampaignSlug !== null) {
      // Sidebar Crown toggle passes the raw folder name (e.g. "Campaign 3"),
      // but rows in `campaigns` are stored slugified ("campaign-3"). Resolve
      // via canonical slug first, then folder_path. groups.active_campaign_slug
      // must reference a real campaigns row, so no third (folder-marker) tier.
      const slugified = slugify(body.activeCampaignSlug);
      let row = db
        .query<{ slug: string }, [string, string]>(
          'SELECT slug FROM campaigns WHERE group_id = ? AND slug = ?',
        )
        .get(id, slugified);
      if (!row) {
        row = db
          .query<{ slug: string }, [string, string]>(
            'SELECT slug FROM campaigns WHERE group_id = ? AND folder_path = ?',
          )
          .get(id, `Campaigns/${body.activeCampaignSlug}`);
      }
      if (!row) {
        return json({ error: 'not_found', detail: 'Unknown campaign for this world.' }, 404);
      }
      canonicalSlug = row.slug;
    }
    db.query('UPDATE groups SET active_campaign_slug = ? WHERE id = ?').run(
      canonicalSlug,
      id,
    );
    // The sidebar reads active_campaign_slug from the (app)/(content) layout,
    // a different segment from /settings/world. router.refresh() on the client
    // only revalidates the current route, so the parent layout's cached RSC
    // payload kept the stale slug in production. Invalidate the whole layout
    // tree so any segment that reads this value re-renders on next navigation.
    revalidatePath('/', 'layout');
  }

  if (body.features !== undefined) {
    setWorldFeatures(id, body.features);
  }

  logAudit({
    action: 'group.switch',
    actorId: session.userId,
    groupId: id,
    target: id,
    details: {
      rename: body.name,
      headerColor: body.headerColor,
      activePersonalityId: body.activePersonalityId,
      activeCampaignSlug: body.activeCampaignSlug,
    },
  });

  return json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;

  try {
    const result = deleteWorld({
      groupId: id,
      actorId: session.userId,
      sessionId: session.id,
    });
    return json({ ok: true, switchToId: result.switchToId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'error';
    if (msg === 'forbidden') return json({ error: 'forbidden' }, 403);
    if (msg === 'last_world')
      return json({ error: 'last_world', detail: 'Cannot delete your only world.' }, 409);
    return json({ error: 'delete_failed', detail: msg }, 500);
  }
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
