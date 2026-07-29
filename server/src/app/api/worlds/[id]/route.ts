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
import { DEFAULT_PERSONALITY, getPersonality, setActivePersonality } from '@/lib/ai/personalities';

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

  // Validate every referenced id BEFORE any write. Previously each
  // field applied its own independent UPDATE statement; if an early
  // field succeeded and a later one referenced an unknown id
  // (personality / campaign), the handler returned 404 with the
  // earlier writes already committed — the client saw an error while
  // the world had, in fact, been partially renamed. Resolving all
  // references up front means a 404 here is returned before anything
  // is written.
  if (
    body.activePersonalityId !== undefined &&
    body.activePersonalityId !== null &&
    body.activePersonalityId !== DEFAULT_PERSONALITY.id &&
    !getPersonality(id, body.activePersonalityId)
  ) {
    return json({ error: 'not_found', detail: 'Unknown personality for this world.' }, 404);
  }
  if (body.activeCampaignSlug !== undefined && body.activeCampaignSlug !== null) {
    const campaign = db
      .query<{ slug: string }, [string, string]>(
        'SELECT slug FROM campaigns WHERE group_id = ? AND slug = ?',
      )
      .get(id, body.activeCampaignSlug);
    if (!campaign) {
      return json({ error: 'not_found', detail: 'Unknown campaign for this world.' }, 404);
    }
  }

  // Every reference is now known-good — apply all fields as a single
  // transaction so an unrelated failure partway through (rather than a
  // validation failure, already ruled out above) can't leave a partial
  // write either. db.transaction() callbacks run synchronously on both
  // adapters; nothing in this block awaits.
  db.transaction(() => {
    if (body.name !== undefined) {
      db.query('UPDATE groups SET name = ? WHERE id = ?').run(body.name, id);
    }
    if (body.headerColor !== undefined) {
      db.query('UPDATE groups SET header_color = ? WHERE id = ?').run(body.headerColor, id);
    }
    if (body.activePersonalityId !== undefined) {
      setActivePersonality(id, body.activePersonalityId);
    }
    if (body.activeCampaignSlug !== undefined) {
      db.query('UPDATE groups SET active_campaign_slug = ? WHERE id = ?').run(
        body.activeCampaignSlug,
        id,
      );
    }
    if (body.features !== undefined) {
      setWorldFeatures(id, body.features);
    }
  })();

  if (body.activeCampaignSlug !== undefined) {
    // The sidebar reads active_campaign_slug from the (app)/(content) layout,
    // a different segment from /settings/world. router.refresh() on the client
    // only revalidates the current route, so the parent layout's cached RSC
    // payload kept the stale slug in production. Invalidate the whole layout
    // tree so any segment that reads this value re-renders on next navigation.
    revalidatePath('/', 'layout');
  }

  logAudit({
    action: 'group.settings_update',
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
