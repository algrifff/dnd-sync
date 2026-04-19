// POST /api/notes/create — create an empty note at the given path.
// Body: { folder: string, name: string }  (name does NOT need .md;
// the server appends it). Returns 201 { path }.

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
import {
  deriveCharacterFromFrontmatter,
  ensureCampaignForPath,
} from '@/lib/characters';
import { getTemplate, type TemplateKind } from '@/lib/templates';

export const dynamic = 'force-dynamic';

const Body = z.object({
  folder: z.string().max(512),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\\0]+$/, 'name must not contain slashes or null bytes'),
  /** Optional entry kind — when set, we pre-seed frontmatter from
   *  the matching template so the sheet UI has defaults to render.
   *  "page" (or omitted) creates a plain note with no kind. */
  kind: z
    .enum(['page', 'pc', 'npc', 'ally', 'villain', 'item', 'location'])
    .optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let parsed: z.infer<typeof Body>;
  try {
    const body = await req.json();
    parsed = Body.parse(body);
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const requestedKind = parsed.kind ?? 'page';

  // Viewers can create plain pages (their own creator-owned notes)
  // and their own PCs; everything else is an admin/editor action.
  if (
    session.role === 'viewer' &&
    requestedKind !== 'page' &&
    requestedKind !== 'pc'
  ) {
    return json({ error: 'forbidden', reason: 'players can create pages or PCs only' }, 403);
  }

  const folder = parsed.folder.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (folder.split('/').some((p) => p === '..' || p === '.')) {
    return json({ error: 'invalid_folder' }, 400);
  }
  const cleanName = parsed.name.trim().replace(/\.(md|canvas)$/i, '');
  if (!cleanName) return json({ error: 'invalid_name' }, 400);
  const path = (folder ? folder + '/' : '') + cleanName + '.md';

  const db = getDb();
  const existing = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, path);
  if ((existing?.n ?? 0) > 0) {
    return json({ error: 'exists', path }, 409);
  }

  // Seed frontmatter from the template whenever a kind is specified.
  // Plain pages still get '{}' so the JSON is valid downstream.
  const frontmatter = buildFrontmatter(requestedKind, cleanName, session.username);

  // Title lives on a dedicated Y.Text so the TitleEditor can subscribe
  // to it independently. Body starts as an empty paragraph — the
  // slash menu (Phase 4 polish) and keyboard shortcuts give users
  // everything they need to build the page.
  const emptyDoc = {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  };
  const schema = getPmSchema();
  const ydoc = prosemirrorJSONToYDoc(schema, emptyDoc, 'default');
  ydoc.getText('title').insert(0, cleanName);
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
    cleanName,
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

  // Run the derive pipeline so the characters / campaigns index
  // rows catch up without waiting for the first collab save.
  try {
    ensureCampaignForPath(session.currentGroupId, path);
    deriveCharacterFromFrontmatter({
      groupId: session.currentGroupId,
      notePath: path,
      frontmatterJson: JSON.stringify(frontmatter),
    });
  } catch (err) {
    console.error('[notes/create] derive failed:', err);
  }

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
    details: { kind: requestedKind },
  });

  return json({ ok: true, path }, 201);
}

function buildFrontmatter(
  kind: 'page' | TemplateKind | 'pc' | 'npc' | 'ally' | 'villain' | 'item' | 'location',
  name: string,
  username: string,
): Record<string, unknown> {
  if (kind === 'page') return {};

  const template = getTemplate(kind as TemplateKind);
  const sheet: Record<string, unknown> = { name };
  if (template) {
    for (const section of template.schema.sections) {
      for (const field of section.fields) {
        if (field.id === 'name') continue;
        if (field.default !== undefined) sheet[field.id] = field.default;
      }
    }
  }

  if (kind === 'pc' || kind === 'npc' || kind === 'ally' || kind === 'villain') {
    const fm: Record<string, unknown> = {
      kind: 'character',
      role: kind,
      template: kind,
      sheet,
    };
    if (kind === 'pc') fm.player = username;
    return fm;
  }
  // item / location share the same 'kind:<literal>' + sheet shape.
  return { kind, template: kind, sheet };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
