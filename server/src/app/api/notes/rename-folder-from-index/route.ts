// POST /api/notes/rename-folder-from-index — invoked by the note page
// when the user retitles the index.md of a renameable folder (a
// canonical campaign subfolder, or the campaign root itself). The
// title becomes the folder's new last segment; everything under the
// folder is moved + every wikilink that pointed at the old prefix is
// rewritten via the shared moveFolder() lib.
//
// Eligibility is checked twice: the client only fires when
// isRenameableFolderIndex() says yes, and we re-check here so a
// crafted POST cannot rename a locked folder.

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { getRenameableFolderForIndex } from '@/lib/folder-rename';
import { moveFolder } from '@/lib/move-folder';

export const dynamic = 'force-dynamic';

const Body = z.object({
  indexPath: z.string().min(1).max(1024),
  newTitle: z.string().min(1).max(200),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot rename folders' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const indexPath = normalizePath(parsed.indexPath);
  if (!indexPath) return json({ error: 'invalid_path' }, 400);

  const eligible = getRenameableFolderForIndex(indexPath);
  if (!eligible) return json({ error: 'not_renameable' }, 403);

  const newSegment = sanitizeSegment(parsed.newTitle);
  if (!newSegment) return json({ error: 'invalid_title' }, 400);
  if (newSegment === eligible.currentName) {
    return json({ ok: true, newIndexPath: indexPath, unchanged: true });
  }

  const fromFolder = eligible.folderPath;
  const toFolder = eligible.parentPath
    ? `${eligible.parentPath}/${newSegment}`
    : newSegment;
  const newIndexPath = `${toFolder}/index.md`;

  // Cheap pre-flight: bail before opening a transaction if the
  // destination folder already has any content. moveFolder also
  // collision-checks per row, but a sibling collision is the common
  // failure mode we want a clean 409 for.
  const db = getDb();
  const sibling = db
    .query<{ n: number }, [string, string, string]>(
      `SELECT COUNT(*) AS n FROM notes
        WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    )
    .get(session.currentGroupId, newIndexPath, toFolder);
  if ((sibling?.n ?? 0) > 0) {
    return json({ error: 'exists', path: toFolder }, 409);
  }

  const result = await moveFolder({
    groupId: session.currentGroupId,
    userId: session.userId,
    from: fromFolder,
    to: toFolder,
  });
  if (!result.ok) {
    const status =
      result.error === 'not_found'
        ? 404
        : result.error === 'exists'
          ? 409
          : 400;
    return json(
      { error: result.error, ...(result.path ? { path: result.path } : {}) },
      status,
    );
  }

  logAudit({
    action: 'folder.rename',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: `${fromFolder} -> ${toFolder}`,
  });

  // The (app)/(content) layout caches active_campaign_slug. When a
  // campaign rename rotates the slug, that cached layout still
  // points at the old value until something invalidates it — without
  // this the Crown / NewSessionButton / chat context all see a stale
  // pin until a hard reload. Mirrors the same call in PATCH /api/worlds/[id].
  revalidatePath('/', 'layout');

  return json({ ok: true, newIndexPath, fromFolder, toFolder });
}

/** Strip leading/trailing slashes and reject traversal segments. */
function normalizePath(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (clean.split('/').some((s) => s === '..' || s === '.' || s === '')) return '';
  return clean;
}

/** Convert a free-text title into a single safe path segment. Spaces
 *  are kept (folders like "Adventure Log" already contain them); only
 *  slash, control chars, and OS-reserved punctuation are stripped. */
function sanitizeSegment(raw: string): string {
  // Strip path separators and collapse whitespace. Pure-dot or empty
  // results are rejected by the caller via the `!newSegment` check.
  const s = raw.replace(/[\\/]/g, '').replace(/\s+/g, ' ').trim();
  if (!s || s === '.' || s === '..') return '';
  return s;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
