// POST /api/sessions/create — seed a new session note.
//
// Body: { campaignSlug, date, title?, sessionNumber? }
//
// Builds a note at Campaigns/<folder>/Adventure Log/<date>-<title-slug>.md
// with frontmatter:
//
//   kind: session
//   template: session
//   campaigns: [<slug>]
//   sheet: { date, session_number?, title?, ...template defaults }
//
// Any member of the World can open a Session, Players included.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { createNote } from '@/lib/create-note';
import { generateSessionTitle } from '@/lib/session-title';
import { nextSessionNumber } from '@/lib/sessions';
import { visibilityFor } from '@/lib/notes';
import { slugify } from '@/lib/slugify';

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

  // createNote runs synchronously through deriveAllIndexes, so on the
  // single server process no other create can read session_notes between
  // this number and the row that records it.
  const sessionNumber =
    body.sessionNumber ??
    nextSessionNumber({
      groupId: session.currentGroupId,
      campaignSlug: body.campaignSlug,
      folderPath: campaign.folder_path,
      vis: visibilityFor(session.role),
    });
  // The caller's picks win over the template defaults.
  const sheet: Record<string, unknown> = { date: body.date, session_number: sessionNumber };
  if (body.title) sheet.title = body.title;

  const titleText =
    body.title ??
    generateSessionTitle(sessionNumber, session.displayName || session.username, body.date);

  // A lost creation race (a rapid double-click on "New session") is the
  // same 409 as a taken path.
  const created = await createNote(session.currentGroupId, {
    userId: session.userId,
    path,
    kind: 'session',
    title: titleText,
    sheet,
    frontmatter: { campaigns: [body.campaignSlug] },
  });
  if (created.status === 'exists') return json({ error: 'exists', path }, 409);

  logAudit({
    action: 'note.create',
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: path,
    details: { kind: 'session', campaign: body.campaignSlug, date: body.date },
  });

  return json({ ok: true, path }, 201);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
