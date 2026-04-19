// GET    /api/import/:id  — current status + plan of an import job.
// DELETE /api/import/:id  — cancel (deletes the temp ZIP + flips row
//                           status to 'cancelled').

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { cancelImportJob, getImportJob } from '@/lib/imports';

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

  cancelImportJob(id);
  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
