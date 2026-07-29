// POST /api/folders/create — create an empty folder marker. Folders
// otherwise emerge implicitly from note paths; this endpoint lets the
// user carve out organisation ahead of any notes existing in it.
//
// Body: { parent: string, name: string }. Returns 201 { path }.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb, isUniqueConstraintError } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { ensureCampaignForPath } from '@/lib/characters';
import { ensureIndexNote } from '@/lib/index-notes';
import {
  deriveFolderIndex,
  isUnderCampaign,
  parentFolderUnderCampaign,
} from '@/lib/campaign-index';
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

  // Conflict with an existing note nested under this path. This is a
  // LIKE-based prefix match against a *different* table, not a key
  // equality — there's no UNIQUE constraint backing it, so unlike the
  // marker-vs-marker case below this check can't be made fully
  // race-free by catching a constraint violation. It narrows the
  // window; it doesn't close it. (A note landing under this exact path
  // between this check and the marker INSERT is the residual race.)
  const noteClash = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path LIKE ? || '/%'",
    )
    .get(session.currentGroupId, path);
  if ((noteClash?.n ?? 0) > 0) {
    return rejectFolder(session, parent, 'exists', { error: 'exists', path }, 409);
  }

  // Marker-vs-marker conflicts ARE backed by folder_markers' own
  // PRIMARY KEY (group_id, path). Attempt the INSERT directly instead
  // of a separate SELECT — two concurrent requests for the same folder
  // would otherwise both pass the pre-check and the loser's raw INSERT
  // would 500 on the constraint violation instead of a clean 409.
  try {
    db.query(
      `INSERT INTO folder_markers (group_id, path, created_at) VALUES (?, ?, ?)`,
    ).run(session.currentGroupId, path, Date.now());
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return rejectFolder(session, parent, 'exists', { error: 'exists', path }, 409);
    }
    throw err;
  }

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

  // Every folder under Campaigns/<slug>/ — campaign roots, canonical
  // subfolders, AND user-created subfolders — gets its own hidden
  // index.md so the sidebar can treat it as a Notion-style page and
  // the auto-managed callout has somewhere to live.
  if (path === 'World Lore') {
    try {
      ensureIndexNote(session.currentGroupId, session.userId, 'World Lore', 'World Lore');
    } catch (err) {
      console.error('[folders/create] ensureIndexNote failed:', err);
    }
  } else if (isUnderCampaign(path)) {
    try {
      ensureIndexNote(session.currentGroupId, session.userId, path, cleanName);
    } catch (err) {
      console.error('[folders/create] ensureIndexNote failed:', err);
    }
    // Seed the new folder's empty index, then refresh its parent so
    // the new folder shows up in the parent's Folders table.
    void deriveFolderIndex(session.currentGroupId, path, {
      userId: session.userId,
    }).catch((err) => {
      console.error('[folders/create] folder index seed failed:', err);
    });
    const parentFolder = parentFolderUnderCampaign(path);
    if (parentFolder) {
      void deriveFolderIndex(session.currentGroupId, parentFolder, {
        userId: session.userId,
      }).catch((err) => {
        console.error('[folders/create] parent index refresh failed:', err);
      });
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
