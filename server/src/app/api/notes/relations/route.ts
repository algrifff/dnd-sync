// POST   /api/notes/relations — add a connection between two Notes.
// DELETE /api/notes/relations — remove a Relationship, or a plain link.
//
// A person adding or removing a Relationship counts as the review that
// ADR 0002 asks for (docs/adr/0003-connections-panel-and-manual-
// relationships.md). `relation` is read from `path`'s side and may be an
// inverse name (`contains`, `employs`, `has_member`...): it is mapped to
// its forward type with the ends swapped, so one fact is one stored row.
// `'link'` inserts (POST) or deletes (DELETE) the plain note_links row
// `path -> otherPath` as given, and touches no Relationship. A link that is
// already gone deletes as 200 `unchanged`; DELETE removes only a manual
// link (`is_manual = 1`), so a body `[[wikilink]]` is `unchanged` too.
//
// The caller must be able to edit BOTH Notes (canEditDoc), the same rule
// the editor uses. A Note that is missing, in another world or hidden by
// visibilityFor() is a 404, checked before the permission so a 403 never
// confirms a hidden Note exists. Removing a Relationship keeps the plain
// link, as ADR 0002 says.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { forwardOf, type RelationType } from '@compendium/shared';
import { requireSession, type Session } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { logAudit } from '@/lib/audit';
import { isNoteVisible } from '@/lib/notes';
import { canEditDoc } from '@/lib/note-permissions';
import { addManualLink, addRelation, removeLink, removeRelation } from '@/lib/relations';

export const dynamic = 'force-dynamic';

const Path = z.string().min(1).max(512);
const Body = z.object({
  path: Path,
  relation: z.string().min(1).max(64),
  otherPath: Path,
});

type Parsed = { path: string; otherPath: string; relation: string };

type Resolved = {
  session: Session;
  body: Parsed;
  /** Null for the plain `'link'`. */
  ends: { from: string; relation: RelationType; to: string } | null;
};

/** CSRF, body, relation name, and the Note checks, shared by POST and DELETE. */
async function resolveRequest(req: NextRequest): Promise<Resolved | Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const body = await parseBody(req);
  if (body instanceof Response) return body;

  const forward = body.relation === 'link' ? null : forwardOf(body.relation);
  if (body.relation !== 'link' && !forward) return json({ error: 'invalid_relation' }, 400);

  const denied = checkNotes(session, body);
  if (denied) return denied;

  return { session, body, ends: forward ? orient(body, forward) : null };
}

export async function POST(req: NextRequest): Promise<Response> {
  const resolved = await resolveRequest(req);
  if (resolved instanceof Response) return resolved;
  const { session, body, ends } = resolved;
  const groupId = session.currentGroupId;

  if (!ends) {
    const { added } = addManualLink({ groupId, from: body.path, to: body.otherPath });
    if (added) audit('relation.add', session, { from: body.path, relation: 'link', to: body.otherPath });
    return json({ ok: true, status: added ? 'added' : 'unchanged' }, added ? 201 : 200);
  }

  const { status } = addRelation({ groupId, ...ends, sessionPath: null, userId: session.userId });
  if (status === 'added') audit('relation.add', session, ends);
  return json({ ok: true, status }, status === 'added' ? 201 : 200);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const resolved = await resolveRequest(req);
  if (resolved instanceof Response) return resolved;
  const { session, body, ends } = resolved;
  const groupId = session.currentGroupId;

  if (!ends) {
    const { removed } = removeLink({ groupId, from: body.path, to: body.otherPath });
    if (removed) audit('relation.remove', session, { from: body.path, relation: 'link', to: body.otherPath });
    return json({ ok: true, status: removed ? 'removed' : 'unchanged' });
  }

  const { status } = removeRelation({ groupId, ...ends });
  if (status === 'missing') return json({ error: 'not_found', reason: 'no such relationship' }, 404);
  audit('relation.remove', session, ends);
  return json({ ok: true, status });
}

async function parseBody(req: NextRequest): Promise<Parsed | Response> {
  try {
    const body = Body.parse(await req.json());
    if (body.path === body.otherPath) return json({ error: 'self_link' }, 400);
    return body;
  } catch (err) {
    return json({ error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' }, 400);
  }
}

/** Both Notes must exist in the caller's world and be visible to them
 *  (404 `not_found`), and the caller must be able to edit both (403
 *  `forbidden`). Null when the request may go ahead. */
function checkNotes(session: Session, body: Parsed): Response | null {
  const paths = [body.path, body.otherPath];
  if (!paths.every((p) => isNoteVisible(session.currentGroupId, session.role, p))) {
    return json({ error: 'not_found' }, 404);
  }
  if (!paths.every((p) => canEditDoc(p, session))) {
    return json({ error: 'forbidden', reason: 'you cannot edit both notes' }, 403);
  }
  return null;
}

/** `from relation to` in stored (forward) form, from `path`'s side. */
function orient(
  body: Parsed,
  forward: { relation: RelationType; swap: boolean },
): { from: string; relation: RelationType; to: string } {
  return forward.swap
    ? { from: body.otherPath, relation: forward.relation, to: body.path }
    : { from: body.path, relation: forward.relation, to: body.otherPath };
}

function audit(
  action: 'relation.add' | 'relation.remove',
  session: Session,
  details: { from: string; relation: string; to: string },
): void {
  logAudit({
    action,
    actorId: session.userId,
    groupId: session.currentGroupId,
    target: details.from,
    details,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
