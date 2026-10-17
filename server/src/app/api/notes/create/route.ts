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
import { getDb, isUniqueConstraintError } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { logAudit } from '@/lib/audit';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { deriveFolderIndex, parentFolderUnderCampaign } from '@/lib/campaign-index';
import { getTemplate, type TemplateKind } from '@/lib/templates';
import { hiddenNotesSql, isAllowedPath, visibilityFor } from '@/lib/notes';
import { GM_MODE_COOKIE, isGmModeOn } from '@/lib/gm-mode';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';

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
    .enum(['page', 'pc', 'npc', 'ally', 'villain', 'item', 'location', 'session', 'monster', 'quest', 'excalidraw'])
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

  // GM mode is admin-only. When the cookie is set on an admin's
  // request, the new note lands in the GM namespace (gm_only=1) and
  // is invisible to players until promoted via /api/notes/promote.
  const gmOnly = isGmModeOn(req.cookies.get(GM_MODE_COOKIE)?.value, session.role);

  // Viewers can create plain pages and quests (their own creator-owned
  // notes) and their own PCs; everything else is an admin/editor action.
  if (
    session.role === 'viewer' &&
    requestedKind !== 'page' &&
    requestedKind !== 'quest' &&
    requestedKind !== 'pc'
  ) {
    return json({ error: 'forbidden', reason: 'players can create pages, quests or PCs only' }, 403);
  }

  const folder = parsed.folder.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (folder.split('/').some((p) => p === '..' || p === '.')) {
    return json({ error: 'invalid_folder' }, 400);
  }
  const baseName = parsed.name.trim().replace(/\.(md|canvas)$/i, '');
  if (!baseName) return json({ error: 'invalid_name' }, 400);
  const basePath = (folder ? folder + '/' : '') + baseName + '.md';

  // Enforce top-level allow-list + no-hidden-segment invariants.
  // Checked against the folder + basename (without the .md suffix) so
  // `.secret.md` and `Random/thing.md` both fail here rather than
  // sneaking in via the note endpoint.
  const allowed = isAllowedPath(folder ? folder + '/' + baseName : baseName);
  if (!allowed.ok) {
    const code = allowed.reason === 'names cannot start with a dot' ? 'invalid_name' : 'forbidden';
    const status = code === 'invalid_name' ? 400 : 403;
    return json({ error: code, reason: allowed.reason }, status);
  }

  const db = getDb();

  // Title lives on a dedicated Y.Text so the TitleEditor can subscribe
  // to it independently. Body starts as an empty paragraph.
  const emptyDoc = {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  };
  const schema = getPmSchema();
  const vis = visibilityFor(session.role);
  const id = randomUUID();
  const now = Date.now();

  // No pre-check + separate INSERT — that leaves a race window where
  // two concurrent requests for the same path both pass a SELECT and
  // the loser's INSERT then throws a raw UNIQUE-constraint error. Try
  // the INSERT directly and translate the conflict.
  //
  // A path held by a note the caller can't see must not answer 409
  // (that would confirm the hidden note exists) and must not touch it,
  // so that case takes the next free " (2)", " (3)" ... name instead,
  // like a duplicate does. A path held by a visible note is still 409.
  let cleanName = baseName;
  let path = basePath;
  let frontmatter: Record<string, unknown> = {};
  for (let n = 2; ; n++) {
    // Seed frontmatter from the template whenever a kind is specified.
    // Plain pages still get '{}' so the JSON is valid downstream.
    frontmatter = buildFrontmatter(requestedKind, cleanName, session.username);
    const ydoc = prosemirrorJSONToYDoc(schema, emptyDoc, 'default');
    ydoc.getText('title').insert(0, cleanName);
    const state = Y.encodeStateAsUpdate(ydoc);
    try {
      db.query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                            content_md, yjs_state, frontmatter_json, byte_size,
                            updated_at, updated_by, created_at, created_by, gm_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        gmOnly ? 1 : 0,
      );
      break;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const visible = db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM notes n WHERE n.group_id = ? AND n.path = ?${hiddenNotesSql('n', vis)}`,
        )
        .get(session.currentGroupId, path);
      if ((visible?.n ?? 0) > 0 || n > 50) return json({ error: 'exists', path }, 409);
      cleanName = `${baseName} (${n})`;
      path = (folder ? folder + '/' : '') + cleanName + '.md';
    }
  }

  // Run the derive pipeline so the characters / campaigns index
  // rows catch up without waiting for the first collab save.
  try {
    deriveAllIndexes({
      groupId: session.currentGroupId,
      notePath: path,
      frontmatterJson: JSON.stringify(frontmatter),
    });
  } catch (err) {
    console.error('[notes/create] derive failed:', err);
  }

  // Refresh the parent folder's auto-managed index so the new note
  // appears in its Notes table.
  const parent = parentFolderUnderCampaign(path);
  if (parent) {
    void deriveFolderIndex(session.currentGroupId, parent, {
      userId: session.userId,
    }).catch((err) => {
      console.error('[notes/create] folder index refresh failed:', err);
    });
  }

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
    details: { kind: requestedKind },
  });

  void captureServer({
    userId: session.userId,
    groupId: session.currentGroupId,
    event: EVENTS.NOTE_CREATED,
    properties: {
      kind: requestedKind,
      path_depth: path.split('/').length,
      top_level: path.split('/')[0],
      via: 'ui',
    },
  });

  return json({ ok: true, path }, 201);
}

function buildFrontmatter(
  kind: NonNullable<z.infer<typeof Body>['kind']>,
  name: string,
  username: string,
): Record<string, unknown> {
  if (kind === 'page') return {};
  if (kind === 'quest') return { kind: 'quest' };
  if (kind === 'excalidraw') {
    return { kind: 'excalidraw', sheet: { name } };
  }

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
