// POST /api/sessions/create — seed a new session note.
//
// Body: { campaignSlug, date, title?, sessionNumber? }
//
// Builds a note at Campaigns/<folder>/Sessions/<date>-<title-slug>.md
// with frontmatter:
//
//   kind: session
//   template: session
//   campaigns: [<slug>]
//   sheet: { date, session_number?, title?, attendees: [...template default], ...rest from template defaults }
//
// Viewers can't create sessions (it's a DM / co-DM chore); admins
// and editors only.

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
import { getTemplate } from '@/lib/templates';
import { generateSessionTitle } from '@/lib/session-title';

export const dynamic = 'force-dynamic';

const Body = z.object({
  campaignSlug: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  title: z.string().min(1).max(200).optional(),
  sessionNumber: z.number().int().min(1).max(9999).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'players cannot create sessions' }, 403);
  }
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

  const db = getDb();
  const campaign = db
    .query<{ folder_path: string }, [string, string]>(
      'SELECT folder_path FROM campaigns WHERE group_id = ? AND slug = ?',
    )
    .get(session.currentGroupId, body.campaignSlug);
  if (!campaign) return json({ error: 'unknown_campaign' }, 404);

  const slugTitle = body.title ? slugify(body.title) : null;
  const fileStem = slugTitle ? `${body.date}-${slugTitle}` : body.date;
  const path = `${campaign.folder_path}/Adventure Log/${fileStem}.md`;

  const existing = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(session.currentGroupId, path);
  if ((existing?.n ?? 0) > 0) {
    return json({ error: 'exists', path }, 409);
  }

  // Seed sheet with template defaults, then layer on the caller's
  // picks so explicit values win.
  const template = getTemplate('session');
  const sheet: Record<string, unknown> = {};
  if (template) {
    for (const section of template.schema.sections) {
      for (const field of section.fields) {
        if (field.default !== undefined) sheet[field.id] = field.default;
      }
    }
  }
  sheet.date = body.date;
  if (body.sessionNumber != null) sheet.session_number = body.sessionNumber;
  if (body.title) sheet.title = body.title;

  const frontmatter: Record<string, unknown> = {
    kind: 'session',
    template: 'session',
    campaigns: [body.campaignSlug],
    sheet,
  };

  const titleText = body.title ?? generateSessionTitle(session.displayName || session.username, body.date);
  const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
  const schema = getPmSchema();
  const ydoc = prosemirrorJSONToYDoc(schema, emptyDoc, 'default');
  ydoc.getText('title').insert(0, titleText);
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
    titleText,
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

  try {
    deriveAllIndexes({
      groupId: session.currentGroupId,
      notePath: path,
      frontmatterJson: JSON.stringify(frontmatter),
    });
  } catch (err) {
    console.error('[sessions/create] derive failed:', err);
  }

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
    details: { kind: 'session', campaign: body.campaignSlug, date: body.date },
  });

  return json({ ok: true, path }, 201);
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
