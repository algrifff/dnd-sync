// POST /api/import/:id/answer
//
// Called by the Smart Import chat modal when the DM submits a reply
// to a question. Appends the message to conversationHistory and
// unblocks the in-process orchestration worker.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getImportJob } from '@/lib/imports';
import { resolveDmQuestion } from '@/lib/import-orchestrate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ content: z.string().min(1).max(2000) });

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const job = getImportJob(id);
  if (!job) return json({ error: 'not_found' }, 404);
  if (job.groupId !== session.currentGroupId) return json({ error: 'not_found' }, 404);
  if (job.createdBy !== session.userId && session.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }
  if (job.status !== 'waiting_for_answer') {
    return json({ error: 'no_pending_question' }, 409);
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const resolved = resolveDmQuestion(id, body.content);
  if (!resolved) {
    // Worker lost its in-process promise (e.g. server restarted).
    return json({ error: 'no_pending_question', reason: 'worker not running — please cancel and start a new import' }, 409);
  }

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
