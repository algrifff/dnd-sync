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
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { detectSkills, buildSystemPrompt } from '@/lib/ai/orchestrator';
import { getToolsForRole, type ToolContext } from '@/lib/ai/tools';

export const dynamic = 'force-dynamic';

type ParsedBody = {
  groupId: string;
  campaignSlug?: string;
  messages: unknown[];
};

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  // Validate groupId matches the caller's active group
  if (session.currentGroupId !== (await peekGroupId(req))) {
    return json({ error: 'forbidden', reason: 'groupId mismatch' }, 403);
  }

  const body = await parseBody(req);
  if (body instanceof Response) return body;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({ error: 'ai_not_configured', reason: 'OPENAI_API_KEY is not set' }, 503);
  }

  const role: 'dm' | 'player' =
    session.role === 'admin' || session.role === 'editor' ? 'dm' : 'player';

  const normalizedMessages = normalizeMessages(body.messages);
  if (normalizedMessages.length === 0) {
    return json({ error: 'invalid_body', detail: 'messages must include at least one text entry' }, 400);
  }

  const lastUserMessage = normalizedMessages
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
  const model  = process.env.OPENAI_MODEL ?? 'gpt-5.4-mini';

  const result = streamText({
    model: openai(model),
    system: buildSystemPrompt({
      groupId: session.currentGroupId,
      role,
      skills,
      ...(body.campaignSlug !== undefined ? { campaignSlug: body.campaignSlug } : {}),
      ...(campaignName !== undefined     ? { campaignName }                     : {}),
    }),
    messages: normalizedMessages,
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

function normalizeMessages(
  messages: unknown[],
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return messages
    .map((msg) => {
      if (!msg || typeof msg !== 'object') return null;
      const role = typeof (msg as { role?: unknown }).role === 'string'
        ? (msg as { role: string }).role
        : '';
      if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;

      const directContent = (msg as { content?: unknown }).content;
      if (typeof directContent === 'string' && directContent.trim()) {
        return {
          role,
          content: directContent,
        };
      }

      const rawParts = (msg as { parts?: unknown }).parts;
      const parts = Array.isArray(rawParts) ? rawParts : [];
      const content = parts
        .filter((p: { type?: unknown; text?: unknown }) => p.type === 'text' && typeof p.text === 'string')
        .map((p: { text?: unknown }) => String(p.text ?? ''))
        .join('')
        .trim();

      if (!content) return null;
      return {
        role,
        content,
      };
    })
    .filter((m): m is { role: 'user' | 'assistant' | 'system'; content: string } => Boolean(m));
}

async function parseBody(req: NextRequest): Promise<ParsedBody | Response> {
  try {
    const raw = await req.json() as Record<string, unknown>;
    const nestedBody = (raw.body && typeof raw.body === 'object')
      ? raw.body as Record<string, unknown>
      : null;
    const nestedData = (raw.data && typeof raw.data === 'object')
      ? raw.data as Record<string, unknown>
      : null;

    const groupId =
      (typeof raw.groupId === 'string' ? raw.groupId : null) ??
      (nestedBody && typeof nestedBody.groupId === 'string' ? nestedBody.groupId : null) ??
      (nestedData && typeof nestedData.groupId === 'string' ? nestedData.groupId : null) ??
      '';

    const campaignSlug =
      (typeof raw.campaignSlug === 'string' ? raw.campaignSlug : undefined) ??
      (nestedBody && typeof nestedBody.campaignSlug === 'string' ? nestedBody.campaignSlug : undefined) ??
      (nestedData && typeof nestedData.campaignSlug === 'string' ? nestedData.campaignSlug : undefined);

    const messages =
      (Array.isArray(raw.messages) ? raw.messages : null) ??
      (nestedBody && Array.isArray(nestedBody.messages) ? nestedBody.messages : null) ??
      (nestedData && Array.isArray(nestedData.messages) ? nestedData.messages : null) ??
      (raw.message ? [raw.message] : null) ??
      (typeof raw.input === 'string' ? [{ role: 'user', content: raw.input }] : null) ??
      (typeof raw.text === 'string' ? [{ role: 'user', content: raw.text }] : null) ??
      (typeof raw.prompt === 'string' ? [{ role: 'user', content: raw.prompt }] : null) ??
      [];

    if (!groupId || messages.length === 0) {
      return json({ error: 'invalid_body', detail: 'groupId and messages are required' }, 400);
    }

    return {
      groupId,
      ...(campaignSlug !== undefined ? { campaignSlug } : {}),
      messages,
    };
  } catch (err) {
    return json({ error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' }, 400);
  }
}
