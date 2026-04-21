// PATCH /api/notes/sheet — update a character's sheet values.
//
// Body: { path, sheet: { [fieldId]: value, ... } }
//
// Merges the incoming key/value pairs into the note's
// frontmatter.sheet map (unrelated frontmatter keys untouched),
// re-derives the characters index, and returns the fresh sheet.
//
// Permission model:
//   * admin / editor          — may write any field
//   * creator of the note     — may write any field (regardless of role)
//   * PC owner (player match) — may write any field on their PC
//   * anyone else             — may write only fields flagged
//                               `playerEditable` on the active template
//                               (HP current, conditions, death saves, etc.)
//
// Writes outside a caller's permission scope are silently dropped;
// the response echoes the merged state so the client can reconcile.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { loadNote } from '@/lib/notes';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { validateSheet } from '@/lib/validateSheet';
import { getTemplate, type TemplateKind } from '@/lib/templates';

export const dynamic = 'force-dynamic';

const Body = z.object({
  path: z.string().min(1).max(512),
  sheet: z.record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      z.null(),
    ]),
  ),
});

const CHARACTER_KINDS: readonly TemplateKind[] = ['pc', 'npc', 'ally', 'villain'];

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const note = loadNote(session.currentGroupId, body.path);
  if (!note) return json({ error: 'not_found' }, 404);

  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>;
  } catch {
    fm = {};
  }
  // Accept any kind with a matching template (character/npc/ally/
  // villain via inferRole; item + location use their kind directly).
  let role: TemplateKind | null = null;
  if (fm.kind === 'character') {
    role = inferRole(fm, body.path);
  } else if (fm.kind === 'item' || fm.kind === 'location' || fm.kind === 'monster') {
    role = fm.kind as TemplateKind;
  }
  if (!role) return json({ error: 'no_structured_sheet' }, 400);
  const template = getTemplate(role);
  const playerEditableIds = new Set<string>();
  if (template) {
    for (const section of template.schema.sections) {
      for (const field of section.fields) {
        if (field.playerEditable) playerEditableIds.add(field.id);
      }
    }
  }

  const isOwner =
    role === 'pc' &&
    typeof fm.player === 'string' &&
    fm.player.trim().toLowerCase() === session.username.toLowerCase();
  const canWriteAll =
    session.role === 'admin' ||
    session.role === 'editor' ||
    note.updated_by === session.userId ||
    isCreatorMatch(session.currentGroupId, body.path, session.userId) ||
    isOwner;

  const currentSheet =
    fm.sheet && typeof fm.sheet === 'object'
      ? ({ ...(fm.sheet as Record<string, unknown>) } as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  for (const [k, v] of Object.entries(body.sheet)) {
    if (!canWriteAll && !playerEditableIds.has(k)) continue;
    if (v === null) delete currentSheet[k];
    else currentSheet[k] = v;
  }

  const fmKind = typeof fm.kind === 'string' ? fm.kind : undefined;
  const vr = validateSheet(fmKind, currentSheet);
  if (!vr.ok) {
    return json({ error: 'invalid_sheet', issues: vr.issues }, 400);
  }
  const validatedSheet = vr.data as Record<string, unknown>;
  const nextFm = { ...fm, sheet: validatedSheet };
  const db = getDb();
  const now = Date.now();
  db.query(
    `UPDATE notes SET frontmatter_json = ?, updated_at = ?, updated_by = ?
       WHERE group_id = ? AND path = ?`,
  ).run(
    JSON.stringify(nextFm),
    now,
    session.userId,
    session.currentGroupId,
    body.path,
  );

  // Re-derive the index so display_name / level / class etc. reflect
  // the new sheet values immediately.
  try {
    deriveAllIndexes({
      groupId: session.currentGroupId,
      notePath: body.path,
      frontmatterJson: JSON.stringify(nextFm),
    });
  } catch (err) {
    console.error('[api/notes/sheet] derive failed:', err);
  }

  return json({ ok: true, sheet: validatedSheet, canWriteAll });
}

function inferRole(
  fm: Record<string, unknown>,
  path: string,
): TemplateKind | null {
  if (typeof fm.role === 'string' && (CHARACTER_KINDS as string[]).includes(fm.role)) {
    return fm.role as TemplateKind;
  }
  const p = path.toLowerCase();
  if (/(^|\/)pcs\//.test(p)) return 'pc';
  if (/(^|\/)allies\//.test(p)) return 'ally';
  if (/(^|\/)villains\//.test(p)) return 'villain';
  if (/(^|\/)npcs\//.test(p)) return 'npc';
  return 'npc';
}

function isCreatorMatch(
  groupId: string,
  path: string,
  userId: string,
): boolean {
  const row = getDb()
    .query<{ created_by: string | null }, [string, string]>(
      'SELECT created_by FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path);
  return !!row && row.created_by === userId;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
