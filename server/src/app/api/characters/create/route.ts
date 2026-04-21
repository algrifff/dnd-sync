// POST /api/characters/create — seed a new character note with
// frontmatter ready for the sheet editor.
//
// Body: { role, name, campaignSlug? }
//
//   role          'pc' | 'npc' | 'ally' | 'villain'
//   name          display name for the character (goes on the title
//                 row, filename, and sheet.name)
//   campaignSlug  optional; when set the file lands under
//                 Campaigns/<folder>/Characters/<Role>/<name>.md
//                 and campaigns: [slug] goes into the frontmatter.
//
// PC creation is open to viewers (players create their own PCs);
// NPC / Ally / Villain creation is admin + editor only. Anyone
// may skip the campaign, in which case the path resolves to
// /Characters/<Role>/<name>.md at the vault root.
//
// Frontmatter is pre-seeded from the active template's field
// defaults so the sheet UI renders useful placeholders from the
// first save.

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
import { type CharacterKind } from '@/lib/characters';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { getTemplate, type TemplateField } from '@/lib/templates';

export const dynamic = 'force-dynamic';

const ROLE_FOLDER: Record<CharacterKind, string> = {
  pc: 'PCs',
  npc: 'NPCs',
  ally: 'Allies',
  villain: 'Villains',
};

const Body = z.object({
  role: z.enum(['pc', 'npc', 'ally', 'villain']),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\\0]+$/, 'name must not contain slashes or null bytes'),
  campaignSlug: z.string().min(1).max(200).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
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

  // Viewers can only create their own PCs; NPC/Ally/Villain are
  // admin + editor territory.
  if (session.role === 'viewer' && body.role !== 'pc') {
    return json({ error: 'forbidden', reason: 'players create PCs only' }, 403);
  }

  const name = body.name.trim();

  // Resolve the folder. If a campaign is given, use its folder_path
  // (derived at ingest). Else drop the new file at the vault root.
  let campaignFolder: string | null = null;
  if (body.campaignSlug) {
    const row = getDb()
      .query<{ folder_path: string }, [string, string]>(
        'SELECT folder_path FROM campaigns WHERE group_id = ? AND slug = ?',
      )
      .get(session.currentGroupId, body.campaignSlug);
    if (!row) return json({ error: 'unknown_campaign' }, 404);
    campaignFolder = row.folder_path;
  }

  const subfolder = ROLE_FOLDER[body.role];
  const path = campaignFolder
    ? `${campaignFolder}/Characters/${subfolder}/${name}.md`
    : `Characters/${subfolder}/${name}.md`;

  const db = getDb();
  const existing = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, path);
  if ((existing?.n ?? 0) > 0) {
    return json({ error: 'exists', path }, 409);
  }

  // Seed frontmatter from the template.
  const template = getTemplate(body.role);
  const sheet: Record<string, unknown> = { name };
  if (template) {
    for (const section of template.schema.sections) {
      for (const field of section.fields) {
        if (field.id === 'name') continue;
        const d = defaultValue(field);
        if (d !== undefined) sheet[field.id] = d;
      }
    }
  }

  const frontmatter: Record<string, unknown> = {
    kind: 'character',
    role: body.role,
    template: body.role,
    sheet,
  };
  if (body.role === 'pc') frontmatter.player = session.username;
  if (body.campaignSlug) frontmatter.campaigns = [body.campaignSlug];

  // Seed an empty body. Title on the Y.Text so the editor picks it
  // up.
  const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
  const schema = getPmSchema();
  const ydoc = prosemirrorJSONToYDoc(schema, emptyDoc, 'default');
  ydoc.getText('title').insert(0, name);
  const state = Y.encodeStateAsUpdate(ydoc);

  const id = randomUUID();
  const now = Date.now();
  db.query(
    `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                        content_md, yjs_state, frontmatter_json, byte_size,
                        updated_at, updated_by, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session.currentGroupId,
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

  // Derive index immediately so the character appears on the
  // dashboard + sidebar dropdown without needing the first collab
  // save.
  try {
    deriveAllIndexes({
      groupId: session.currentGroupId,
      notePath: path,
      frontmatterJson: JSON.stringify(frontmatter),
    });
  } catch (err) {
    console.error('[characters/create] derive failed:', err);
  }

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
    details: { role: body.role, campaign: body.campaignSlug ?? null },
  });

  return json({ ok: true, path }, 201);
}

function defaultValue(field: TemplateField): unknown {
  if (field.default !== undefined) return field.default;
  // Without an explicit default we leave the key out of the sheet
  // so the renderer can show the placeholder / blank state.
  return undefined;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
