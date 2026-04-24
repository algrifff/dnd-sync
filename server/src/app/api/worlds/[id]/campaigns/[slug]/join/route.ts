// POST /api/worlds/[id]/campaigns/[slug]/join — join the active
// campaign with one of the caller's user-level characters.
//
// Body: { userCharacterId }
//
// Auto-approves if the caller is a member of the world. Creates a
// mirror note at Campaigns/<folder>/Characters/PCs/<name>.md seeded
// from the user_character's sheet, then inserts a binding row so the
// two-way sync engine keeps them aligned.

import { randomUUID } from 'node:crypto';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { logAudit } from '@/lib/audit';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { getUserCharacter } from '@/lib/userCharacters';
import { syncMasterToNotes } from '@/lib/userCharacterSync';

export const dynamic = 'force-dynamic';

const Body = z.object({
  userCharacterId: z.string().min(1).max(128),
});

type Ctx = { params: Promise<{ id: string; slug: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id: groupId, slug } = await ctx.params;

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

  const membership = db
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(session.userId, groupId);
  if (!membership) return json({ error: 'forbidden' }, 403);

  const group = db
    .query<{ active_campaign_slug: string | null }, [string]>(
      'SELECT active_campaign_slug FROM groups WHERE id = ?',
    )
    .get(groupId);
  if (!group) return json({ error: 'not_found', detail: 'world' }, 404);
  // Mirror the layout's fallback: if no campaign is pinned, treat the
  // most-recently-created campaign as active. Without this the sidebar
  // shows a party for a campaign the join route refuses to accept.
  const effectiveActiveSlug =
    group.active_campaign_slug ??
    db
      .query<{ slug: string }, [string]>(
        'SELECT slug FROM campaigns WHERE group_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(groupId)?.slug ??
    null;
  if (effectiveActiveSlug !== slug) {
    return json(
      { error: 'not_active_campaign', detail: 'only the active campaign is joinable' },
      400,
    );
  }

  const campaign = db
    .query<{ folder_path: string }, [string, string]>(
      'SELECT folder_path FROM campaigns WHERE group_id = ? AND slug = ?',
    )
    .get(groupId, slug);
  if (!campaign) return json({ error: 'unknown_campaign' }, 404);

  const uc = getUserCharacter(body.userCharacterId, session.userId);
  if (!uc) return json({ error: 'not_found', detail: 'character' }, 404);

  const existingBinding = db
    .query<{ note_id: string }, [string, string, string]>(
      `SELECT note_id FROM user_character_bindings
         WHERE user_character_id = ? AND group_id = ? AND campaign_slug = ?`,
    )
    .get(uc.id, groupId, slug);
  if (existingBinding) {
    return json({ error: 'already_joined', noteId: existingBinding.note_id }, 409);
  }

  const name = uc.name.trim();
  if (!/^[^/\\\0]+$/.test(name)) {
    return json({ error: 'invalid_name' }, 400);
  }
  const path = `${campaign.folder_path}/Characters/PCs/${name}.md`;

  const conflict = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path);
  if ((conflict?.n ?? 0) > 0) {
    return json({ error: 'exists', path }, 409);
  }

  const frontmatter: Record<string, unknown> = {
    kind: 'character',
    role: 'pc',
    template: 'pc',
    player: session.username,
    campaigns: [slug],
    sheet: { ...uc.sheet, name },
  };

  const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
  const schema = getPmSchema();
  const ydoc = prosemirrorJSONToYDoc(schema, emptyDoc, 'default');
  ydoc.getText('title').insert(0, name);
  const state = Y.encodeStateAsUpdate(ydoc);

  const noteId = randomUUID();
  const now = Date.now();
  db.query(
    `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                        content_md, yjs_state, frontmatter_json, byte_size,
                        updated_at, updated_by, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    noteId,
    groupId,
    path,
    name,
    JSON.stringify(emptyDoc),
    '',
    '',
    state,
    JSON.stringify(frontmatter),
    0,
    now,
    session.userId,
    now,
    session.userId,
  );

  db.query(
    `INSERT INTO user_character_bindings
       (user_character_id, group_id, campaign_slug, note_id, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(uc.id, groupId, slug, noteId, now);

  // Push the master sheet through the sync engine so legacy flat
  // mirror keys (hp_current, ac, str/…) and derived indexes are
  // populated from the first save.
  try {
    syncMasterToNotes(uc.id);
  } catch (err) {
    console.error('[worlds/campaigns/join] sync failed:', err);
    try {
      deriveAllIndexes({
        groupId,
        notePath: path,
        frontmatterJson: JSON.stringify(frontmatter),
      });
    } catch (derr) {
      console.error('[worlds/campaigns/join] derive fallback failed:', derr);
    }
  }

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId,
    target: path,
    details: { role: 'pc', campaign: slug, fromUserCharacter: uc.id },
  });

  return json({ ok: true, path, noteId }, 201);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
