// POST /api/campaigns/delete — destroy a campaign in one shot:
// every note + folder under Campaigns/<slug>/, the campaigns row,
// the character_campaigns and session_notes that reference the slug,
// and clear the world's active_campaign_slug if it matched. Body:
// { slug }. Always cascades; the client must confirm.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { closeDocumentConnections } from '@/collab/server';
import { deriveFolderIndexesFor } from '@/lib/campaign-index';

export const dynamic = 'force-dynamic';

const Body = z.object({
  slug: z.string().min(1).max(256),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  // Only world owners destroy campaigns. Non-owner GMs (editors) can
  // edit notes inside the campaign but cannot blow the whole thing away.
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

  const { slug } = parsed;
  if (slug.includes('/') || slug === '.' || slug === '..') {
    return json({ error: 'invalid_slug' }, 400);
  }

  const db = getDb();
  const groupId = session.currentGroupId;

  const campaign = db
    .query<{ slug: string; folder_path: string; name: string }, [string, string]>(
      `SELECT slug, folder_path, name FROM campaigns
        WHERE group_id = ? AND slug = ?`,
    )
    .get(groupId, slug);
  if (!campaign) {
    return json({ error: 'not_found', reason: `campaign '${slug}' not in this world` }, 404);
  }

  // Owner-only — match the privilege gate on /api/worlds/[id] settings.
  const member = db
    .query<{ role: string }, [string, string]>(
      `SELECT role FROM group_members WHERE group_id = ? AND user_id = ?`,
    )
    .get(groupId, session.userId);
  if (!member || member.role !== 'admin') {
    return json({ error: 'forbidden', reason: 'only world owners can delete campaigns' }, 403);
  }

  const folderPath = campaign.folder_path;
  const notes = db
    .query<{ path: string }, [string, string, string]>(
      `SELECT path FROM notes
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    )
    .all(groupId, folderPath, folderPath);

  db.transaction(() => {
    db.exec('PRAGMA defer_foreign_keys = 1');
    for (const n of notes) {
      db.query(
        'DELETE FROM note_links WHERE group_id = ? AND (from_path = ? OR to_path = ?)',
      ).run(groupId, n.path, n.path);
      db.query('DELETE FROM tags WHERE group_id = ? AND path = ?').run(groupId, n.path);
      db.query('DELETE FROM aliases WHERE group_id = ? AND path = ?').run(groupId, n.path);
      // characters / session_notes / items / locations / creatures all
      // have ON DELETE CASCADE off notes(group_id, path).
      db.query('DELETE FROM notes WHERE group_id = ? AND path = ?').run(groupId, n.path);
      db.query('DELETE FROM notes_fts WHERE path = ? AND group_id = ?').run(
        n.path,
        groupId,
      );
    }
    db.query(
      `DELETE FROM folder_markers
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    ).run(groupId, folderPath, folderPath);

    // Belt-and-braces cleanup of slug-keyed indexes (most rows would
    // already be gone via the notes cascade, but a stale row with no
    // backing note would survive otherwise).
    db.query(
      `DELETE FROM character_campaigns WHERE group_id = ? AND campaign_slug = ?`,
    ).run(groupId, slug);
    db.query(
      `DELETE FROM session_notes WHERE group_id = ? AND campaign_slug = ?`,
    ).run(groupId, slug);

    db.query(`DELETE FROM campaigns WHERE group_id = ? AND slug = ?`).run(groupId, slug);

    // Unpin the active campaign if the user just deleted it.
    db.query(
      `UPDATE groups SET active_campaign_slug = NULL
        WHERE id = ? AND active_campaign_slug = ?`,
    ).run(groupId, slug);
  })();

  for (const n of notes) {
    await closeDocumentConnections(n.path);
  }

  await deriveFolderIndexesFor(
    groupId,
    [folderPath, ...notes.map((n) => n.path)],
  );

  logAudit({
    action: 'campaign.destroy',
    actorId: session.userId,
    groupId,
    target: slug,
    details: { folderPath, notesDeleted: notes.length, name: campaign.name },
  });

  return json({ ok: true, deleted: notes.length });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
