// GET    /api/import/:id  — current status + plan of an import job.
// DELETE /api/import/:id  — cancel (deletes the temp ZIP + flips row
//                           status to 'cancelled').

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import {
  cancelImportJob,
  getImportJob,
  updateImportJob,
} from '@/lib/imports';
import { abortAnalyse, type PlannedNote } from '@/lib/import-analyse';
import { abortOrchestration } from '@/lib/import-orchestrate';
import type { ImportPlan } from '@/lib/import-parse';
import type { ImportClassifyResult } from '@/lib/ai/skills/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const job = getImportJob(id);
  if (!job) return json({ error: 'not_found' }, 404);

  // An import is scoped to a world. Block cross-world reads so a
  // member of one world can't poke at another's import state.
  if (job.groupId !== session.currentGroupId) {
    return json({ error: 'not_found' }, 404);
  }
  // Only the job's owner or admins can see it.
  if (job.createdBy !== session.userId && session.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }

  return json({ job });
}

const PatchBody = z.object({
  notes: z
    .array(
      z.object({
        id: z.string().min(1),
        accepted: z.boolean().optional(),
        canonicalPath: z.string().min(1).max(1024).optional(),
        kind: z
          .enum(['character', 'location', 'item', 'session', 'lore', 'plain'])
          .optional(),
        role: z.enum(['pc', 'npc', 'ally', 'villain']).nullable().optional(),
      }),
    )
    .optional(),
});

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const job = getImportJob(id);
  if (!job) return json({ error: 'not_found' }, 404);
  if (job.groupId !== session.currentGroupId) {
    return json({ error: 'not_found' }, 404);
  }
  if (job.createdBy !== session.userId && session.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }
  if (job.status !== 'ready' && job.status !== 'uploaded') {
    return json({ error: 'bad_state', status: job.status }, 409);
  }

  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  const plan = job.plan as
    | (ImportPlan & { plannedNotes?: PlannedNote[] })
    | null;
  if (!plan || !plan.plannedNotes) {
    return json({ error: 'no_plan' }, 409);
  }

  const updates = new Map<string, z.infer<typeof PatchBody>['notes'] extends
    | Array<infer T>
    | undefined
    ? T
    : never>();
  for (const u of body.notes ?? []) updates.set(u.id, u);

  // Apply edits into the plan in-place and persist the full plan
  // back. Editing a row's kind/role also updates the cached
  // classification so the apply step sees the new values.
  let touched = 0;
  for (const note of plan.plannedNotes) {
    const u = updates.get(note.id);
    if (!u) continue;
    touched++;
    if (u.accepted !== undefined) note.accepted = u.accepted;
    if (u.canonicalPath !== undefined && note.classification) {
      note.classification.canonicalPath = u.canonicalPath.trim();
    }
    if ((u.kind !== undefined || u.role !== undefined) && note.classification) {
      const c: ImportClassifyResult = {
        ...note.classification,
      };
      if (u.kind !== undefined) c.kind = u.kind;
      if (u.role !== undefined) c.role = u.role;
      note.classification = c;
    }
  }

  updateImportJob(id, { plan });
  return json({ ok: true, touched });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const job = getImportJob(id);
  if (!job) return json({ error: 'not_found' }, 404);
  if (job.groupId !== session.currentGroupId) {
    return json({ error: 'not_found' }, 404);
  }
  if (job.createdBy !== session.userId && session.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }
  if (job.status === 'applied') {
    return json({ error: 'already_applied' }, 409);
  }

  // Kill any in-flight workers (analyse or orchestrate) before the
  // terminal flip so abortable fetch calls bail out cleanly.
  abortAnalyse(id);
  abortOrchestration(id);
  cancelImportJob(id);
  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
