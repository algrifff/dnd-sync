// POST /api/notes/assign-player — assign a PC note to a world member.
// Admin-only. Patches frontmatter.player, syncs the characters index, and
// upserts a user_characters entry so the character appears on the target
// player's /me dashboard.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { deriveCharacterFromFrontmatter } from '@/lib/characters';
import { createUserCharacter } from '@/lib/userCharacters';

export const dynamic = 'force-dynamic';

const Body = z.object({
  path: z.string().min(1),
  targetUserId: z.string().min(1),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  if (session.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const db = getDb();
  const groupId = session.currentGroupId;

  // Load note
  const note = db
    .query<{ id: string; frontmatter_json: string }, [string, string]>(
      'SELECT id, frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, body.path);
  if (!note) {
    return json({ error: 'not_found' }, 404);
  }

  // Parse frontmatter and verify this is a character note
  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>;
  } catch {
    fm = {};
  }
  if (fm.kind !== 'character') {
    return json(
      { error: 'not_a_character', reason: 'Only character notes can be assigned to a player.' },
      400,
    );
  }

  // Verify target user is a member of this world
  const target = db
    .query<{ id: string; username: string }, [string, string]>(
      `SELECT u.id, u.username
         FROM users u
         JOIN group_members gm ON gm.user_id = u.id
        WHERE u.id = ? AND gm.group_id = ?`,
    )
    .get(body.targetUserId, groupId);
  if (!target) {
    return json({ error: 'member_not_found' }, 404);
  }

  // Patch frontmatter player field and write back
  fm.player = target.username;
  const newFrontmatterJson = JSON.stringify(fm);
  db.query('UPDATE notes SET frontmatter_json = ? WHERE group_id = ? AND path = ?').run(
    newFrontmatterJson,
    groupId,
    body.path,
  );

  // Sync characters index (player_user_id etc.)
  deriveCharacterFromFrontmatter({
    groupId,
    notePath: body.path,
    frontmatterJson: newFrontmatterJson,
  });

  // Upsert user_characters so the character appears on the player's /me dashboard.
  // Check for an existing binding first — if one exists, transfer its ownership.
  const existingBinding = db
    .query<{ user_character_id: string }, [string, string]>(
      'SELECT user_character_id FROM user_character_bindings WHERE note_id = ? AND group_id = ?',
    )
    .get(note.id, groupId);

  const sheet =
    fm.sheet && typeof fm.sheet === 'object' && !Array.isArray(fm.sheet)
      ? (fm.sheet as Record<string, unknown>)
      : {};
  const charName =
    typeof sheet.name === 'string' && sheet.name.trim()
      ? sheet.name.trim()
      : body.path.slice(body.path.lastIndexOf('/') + 1).replace(/\.md$/i, '');

  if (existingBinding) {
    db.query(
      'UPDATE user_characters SET owner_user_id = ?, updated_at = ? WHERE id = ?',
    ).run(body.targetUserId, Date.now(), existingBinding.user_character_id);
  } else {
    // Create a new user_character seeded from the note's sheet data
    let uc;
    try {
      uc = createUserCharacter(body.targetUserId, {
        name: charName,
        kind: 'character',
        sheet,
        portraitUrl: typeof fm.portrait === 'string' ? fm.portrait : null,
      });
    } catch {
      // Fall back to minimal data if sheet validation rejects the note's shape
      uc = createUserCharacter(body.targetUserId, { name: charName, kind: 'character' });
    }

    // Bind to the world note so two-way sync can work. campaign_slug is
    // extracted from the path when the note lives under Campaigns/<slug>/.
    const campaignMatch = /^Campaigns\/([^/]+)\//.exec(body.path);
    if (campaignMatch) {
      const campaignSlug = campaignMatch[1]!;
      try {
        db.query(
          `INSERT OR IGNORE INTO user_character_bindings
             (user_character_id, group_id, campaign_slug, note_id, joined_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(uc.id, groupId, campaignSlug, note.id, Date.now());
      } catch {
        // Binding is best-effort; the user_character was already created above.
      }
    }
  }

  logAudit({
    action: 'character.assign_player',
    actorId: session.userId,
    groupId,
    target: body.path,
    details: { targetUserId: body.targetUserId, targetUsername: target.username },
  });

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
