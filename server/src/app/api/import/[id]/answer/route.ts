// POST /api/import/:id/answer
//
// Called by the Smart Import chat modal when the DM submits a reply
// to a question. Appends the message to conversationHistory and
// unblocks the in-process orchestration worker.

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getImportJob, updateImportJob } from '@/lib/imports';
import { resolveDmQuestion, startOrchestration, isOrchestrationRunning } from '@/lib/import-orchestrate';

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
    // Worker lost its in-process resolver (e.g. hot reload / server restart).
    // Persist the reply to conversationHistory FIRST — otherwise the
    // restarted worker re-enters askDmChat with no record of the answer
    // and re-asks the same question. askDmChat detects a user reply at
    // the tail of history and returns it directly on resume.
    const fresh = getImportJob(id);
    const plan = (fresh?.plan ?? null) as
      | { orchestration?: { conversationHistory: Array<{ role: 'assistant' | 'user'; content: string; timestamp: number }> } }
      | null;
    if (plan?.orchestration) {
      const last = plan.orchestration.conversationHistory.at(-1);
      if (!(last && last.role === 'user' && last.content === body.content)) {
        plan.orchestration.conversationHistory.push({
          role: 'user',
          content: body.content,
          timestamp: Date.now(),
        });
      }
      updateImportJob(id, { plan });
    }
    if (!isOrchestrationRunning(id)) {
      updateImportJob(id, { status: 'ready' });
      startOrchestration(id);
    }
    return json({ ok: true, reconnecting: true });
  }

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
