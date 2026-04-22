// POST /api/sessions/end — AI-powered session wrap-up.
//
// Reads the session note, runs the AI with entity tools to extract
// NPCs / locations / creatures encountered and update/create entity
// notes + backlinks, then marks the session closed.
//
// Body: { sessionPath: string, force?: boolean }
//   force=true lets you re-run a closed session (user has confirmed
//   they accept the risk of duplicate info).

import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { loadNote } from '@/lib/notes';
import { getDb } from '@/lib/db';
import { createTools, type ToolContext } from '@/lib/ai/tools';
import { listCampaigns } from '@/lib/characters';

export const dynamic = 'force-dynamic';

const Body = z.object({
  sessionPath: z.string().min(1).max(512),
  force: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  if (session.role === 'viewer') {
    return json({ error: 'forbidden', reason: 'viewers cannot end sessions' }, 403);
  }
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return json({ error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad' }, 400);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({ error: 'ai_not_configured', reason: 'OPENAI_API_KEY is not set' }, 503);
  }

  const note = loadNote(session.currentGroupId, body.sessionPath);
  if (!note) return json({ error: 'not_found' }, 404);

  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_note', reason: 'cannot parse frontmatter' }, 400);
  }
  if (fm.kind !== 'session') {
    return json({ error: 'not_a_session', reason: 'note is not a session kind' }, 400);
  }

  // Check current status
  const row = getDb()
    .query<{ status: string }, [string, string]>(
      `SELECT status FROM session_notes WHERE group_id=? AND note_path=?`,
    )
    .get(session.currentGroupId, body.sessionPath);
  const status = row?.status ?? 'open';

  if (status === 'closed' && !body.force) {
    return json({ error: 'already_closed' }, 409);
  }

  // Resolve campaign slug from frontmatter or path
  const fmCampaigns = Array.isArray(fm.campaigns) ? fm.campaigns : [];
  const campaignSlug: string | undefined =
    typeof fmCampaigns[0] === 'string'
      ? fmCampaigns[0]
      : /^Campaigns\/([^/]+)\//.exec(body.sessionPath)?.[1];

  // Pull sheet date for the prompt
  const sheet = fm.sheet && typeof fm.sheet === 'object' ? (fm.sheet as Record<string, unknown>) : {};
  const sessionDate = typeof sheet.date === 'string' ? sheet.date : '';
  const sessionTitle = typeof sheet.title === 'string' ? sheet.title : note.title;

  const content = note.content_md.trim();

  const toolCtx: ToolContext = {
    groupId: session.currentGroupId,
    userId: session.userId,
    role: 'dm',
    ...(campaignSlug !== undefined ? { campaignSlug } : {}),
  };

  // Expose only the tools needed for extraction — not session_close/apply/inventory
  const allTools = createTools(toolCtx);
  const tools = {
    campaign_list:       allTools.campaign_list,
    entity_search:       allTools.entity_search,
    entity_create:       allTools.entity_create,
    entity_edit_content: allTools.entity_edit_content,
    backlink_create:     allTools.backlink_create,
  };

  // Build a focused campaign context line
  let campaignContext = 'No campaign selected.';
  if (campaignSlug) {
    const campaigns = listCampaigns(session.currentGroupId);
    const match = campaigns.find((c) => c.slug === campaignSlug);
    campaignContext = match
      ? `Campaign: ${match.name} (slug: ${campaignSlug})`
      : `Campaign slug: ${campaignSlug}`;
  }

  const systemPrompt = `You are an autonomous D&D session-end processor for the Compendium app.

Your task: analyse the session notes below and update the campaign knowledge base.

${campaignContext}
Session path: ${body.sessionPath}
Session date: ${sessionDate || 'unknown'}

## Rules
1. Extract every named NPC, villain, creature, monster, location, and notable item from the notes.
2. NEVER create player characters (kind=character / pc / ally) — skip those entirely.
3. For each entity:
   a. Call entity_search first to check if it already exists.
   b. If it exists: call entity_edit_content to append a brief note about what happened this session (one or two sentences, past tense).
   c. If it does NOT exist: call entity_create to create it with appropriate kind and any details mentioned.
4. After handling each entity: call backlink_create with fromPath=<entity_path> and toPath=<session_path> to link the entity back to this session. Do NOT create links FROM the session note itself.
5. If you need the campaign slug, call campaign_list.
6. Work through all entities before writing your summary reply.`;

  const userPrompt = content
    ? `Session notes:\n\n${content}`
    : 'The session notes are empty — there is nothing to process.';

  const openai = createOpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

  let resultText: string;
  try {
    const result = await generateText({
      model: openai(model),
      system: systemPrompt,
      prompt: userPrompt,
      tools,
      stopWhen: stepCountIs(20),
    });
    resultText = result.text || 'Session processed.';
  } catch (err) {
    console.error('[sessions/end] AI error:', err);
    return json({ error: 'ai_error', reason: err instanceof Error ? err.message : 'unknown' }, 502);
  }

  // Mark session closed (upsert in case session_notes row doesn't exist yet)
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO session_notes (group_id, note_path, updated_at, status, closed_at, closed_by)
       VALUES (?, ?, ?, 'closed', ?, ?)
       ON CONFLICT (group_id, note_path)
       DO UPDATE SET status='closed', closed_at=excluded.closed_at, closed_by=excluded.closed_by`,
    )
    .run(session.currentGroupId, body.sessionPath, now, now, session.userId);

  return json({ ok: true, summary: resultText, title: sessionTitle }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
