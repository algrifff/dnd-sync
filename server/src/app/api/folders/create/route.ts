// POST /api/folders/create — create an empty folder marker. Folders
// otherwise emerge implicitly from note paths; this endpoint lets the
// user carve out organisation ahead of any notes existing in it.
//
// Body: { parent: string, name: string }. Returns 201 { path }.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { ensureCampaignForPath } from '@/lib/characters';
import { ensureIndexNote } from '@/lib/index-notes';
import { isAllowedPath } from '@/lib/notes';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

export const dynamic = 'force-dynamic';

const Body = z.object({
  parent: z.string().max(512),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\\0]+$/, 'name must not contain slashes or null bytes'),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot create folders' }, 403);
  }

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return rejectFolder(session, '', 'invalid_body', {
      error: 'invalid_body',
      detail: err instanceof Error ? err.message : 'bad',
    }, 400);
  }

  const parent = parsed.parent.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (parent.split('/').some((p) => p === '..' || p === '.')) {
    return rejectFolder(session, parent, 'invalid_parent', { error: 'invalid_parent' }, 400);
  }
  const cleanName = parsed.name.trim();
  if (!cleanName) return rejectFolder(session, parent, 'invalid_name', { error: 'invalid_name' }, 400);
  const path = (parent ? parent + '/' : '') + cleanName;

  // Reject hidden names outright — dot-prefixed segments are reserved
  // for ephemeral collab docs (.presence, .graph-state:<id>) and must
  // never surface in the user-visible tree.
  const allowed = isAllowedPath(path);
  if (!allowed.ok) {
    const code = allowed.reason === 'names cannot start with a dot' ? 'invalid_name' : 'forbidden';
    const status = code === 'invalid_name' ? 400 : 403;
    return rejectFolder(session, parent, allowed.reason, { error: code, reason: allowed.reason }, status);
  }

  // Only the world owner (group admin) may start a new campaign —
  // editors can populate existing campaigns but not create them.
  if (parent === 'Campaigns' && session.role !== 'admin') {
    return rejectFolder(
      session,
      parent,
      'not_admin',
      { error: 'forbidden', reason: 'only the world owner can create campaigns' },
      403,
    );
  }

  const db = getDb();

  // Conflicts: a note or another marker already sitting at this path.
  const noteClash = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path LIKE ? || '/%'",
    )
    .get(session.currentGroupId, path);
  const markerClash = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM folder_markers WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, path);
  if ((markerClash?.n ?? 0) > 0 || (noteClash?.n ?? 0) > 0) {
    return rejectFolder(session, parent, 'exists', { error: 'exists', path }, 409);
  }

  db.query(
    `INSERT INTO folder_markers (group_id, path, created_at) VALUES (?, ?, ?)`,
  ).run(session.currentGroupId, path, Date.now());

  // Register a campaigns row the moment a "Campaigns/<name>" folder
  // exists, so /sessions + /characters dashboards pick it up in
  // their dropdown without waiting for the first note to land.
  // Also covers a campaign's subfolders (Characters/, Sessions/…).
  try {
    // ensureCampaignForPath expects a note path underneath the
    // campaign folder, so feed it a synthetic descendant.
    ensureCampaignForPath(session.currentGroupId, path + '/.marker');
  } catch (err) {
    console.error('[folders/create] ensureCampaignForPath failed:', err);
  }

  // Campaign roots + World Lore get a hidden index.md so the sidebar
  // can treat the folder row as a Notion-style page, and the graph
  // view shows the hub as a real node.
  if (parent === 'Campaigns') {
    try {
      ensureIndexNote(session.currentGroupId, session.userId, path, cleanName);
    } catch (err) {
      console.error('[folders/create] ensureIndexNote failed:', err);
    }
  } else if (path === 'World Lore') {
    try {
      ensureIndexNote(session.currentGroupId, session.userId, 'World Lore', 'World Lore');
    } catch (err) {
      console.error('[folders/create] ensureIndexNote failed:', err);
    }
  }

  logAudit({
    action: 'folder.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
  });

  void captureServer({
    userId: session.userId,
    groupId: session.currentGroupId,
    event: EVENTS.FOLDER_CREATED,
    properties: {
      parent,
      name: cleanName,
      depth: parent ? parent.split('/').length + 1 : 1,
      is_campaign_root: parent === 'Campaigns',
      is_world_lore_root: path === 'World Lore',
    },
  });

  return json({ ok: true, path }, 201);
}

/** Emit a `folder_create_rejected` event and return the 4xx response
 *  in one go. Only used for expected user-error branches so the audit
 *  trail shows *why* folder attempts are failing. */
function rejectFolder(
  session: { userId: string; currentGroupId: string },
  parent: string,
  reason: string,
  body: Record<string, unknown>,
  status: number,
): Response {
  void captureServer({
    userId: session.userId,
    groupId: session.currentGroupId,
    event: EVENTS.FOLDER_CREATE_REJECTED,
    properties: { parent, reason, status },
  });
  return json(body, status);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
