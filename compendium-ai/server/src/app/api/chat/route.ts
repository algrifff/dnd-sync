// POST /api/chat — streaming AI chat with tool calls.
//
// Accepts a message history + campaign context, detects which skills
// are relevant to the latest message, builds a targeted system prompt,
// and streams a response via the Vercel AI SDK.
//
// Auth: requireSession (cookie session). The groupId in the body must
// match the session's current_group_id — no cross-group data access.

import { createOpenAI } from '@ai-sdk/openai';
import { streamText, stepCountIs } from 'ai';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { detectSkills, buildSystemPrompt } from '@/lib/ai/orchestrator';
import { getToolsForRole, type ToolContext } from '@/lib/ai/tools';

export const dynamic = 'force-dynamic';

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const BodySchema = z.object({
  messages:     z.array(MessageSchema).min(1).max(100),
  groupId:      z.string().min(1),
  campaignSlug: z.string().optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  // Validate groupId matches the caller's active group
  if (session.currentGroupId !== (await peekGroupId(req))) {
    return json({ error: 'forbidden', reason: 'groupId mismatch' }, 403);
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({ error: 'ai_not_configured', reason: 'OPENAI_API_KEY is not set' }, 503);
  }

  const role: 'dm' | 'player' =
    session.role === 'admin' || session.role === 'editor' ? 'dm' : 'player';

  const lastUserMessage = body.messages
    .slice()
    .reverse()
    .find((m) => m.role === 'user')?.content ?? '';

  const skills = detectSkills(lastUserMessage);

  // Look up campaign display name for the prompt context
  let campaignName: string | undefined;
  if (body.campaignSlug) {
    const row = getDb()
      .query<{ name: string }, [string, string]>(
        `SELECT name FROM campaigns WHERE group_id = ? AND slug = ?`,
      )
      .get(session.currentGroupId, body.campaignSlug);
    campaignName = row?.name;
  }

  const toolCtx: ToolContext = {
    groupId: session.currentGroupId,
    userId:  session.userId,
    role,
    ...(body.campaignSlug !== undefined ? { campaignSlug: body.campaignSlug } : {}),
  };

  const openai = createOpenAI({ apiKey });
  const model  = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

  const result = streamText({
    model: openai(model),
    system: buildSystemPrompt({
      groupId: session.currentGroupId,
      role,
      skills,
      ...(body.campaignSlug !== undefined ? { campaignSlug: body.campaignSlug } : {}),
      ...(campaignName !== undefined     ? { campaignName }                     : {}),
    }),
    messages: body.messages,
    tools:    getToolsForRole(toolCtx),
    stopWhen: stepCountIs(8),
  });

  return result.toUIMessageStreamResponse();
}

// ── Helpers ────────────────────────────────────────────────────────────

// Peek at the groupId before fully parsing the body (avoids double-parse)
async function peekGroupId(req: NextRequest): Promise<string | null> {
  try {
    const clone = req.clone();
    const body = await clone.json() as { groupId?: unknown };
    return typeof body.groupId === 'string' ? body.groupId : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
