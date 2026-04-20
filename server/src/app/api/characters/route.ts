// GET /api/characters — list characters in the current session's
// group. Optional filters via query string:
//
//   ?mine=1            player_user_id = session.userId
//   ?kind=pc|npc|ally|villain
//   ?campaign=<slug>   filter by campaign membership
//
// Any authenticated user can query; the data is already readable on
// the respective note pages so the listing adds no new exposure.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  listCharacters,
  type CharacterKind,
  type CharacterListRow,
} from '@/lib/characters';

export const dynamic = 'force-dynamic';

const KINDS = new Set<CharacterKind>(['pc', 'npc', 'ally', 'villain']);

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const params = req.nextUrl.searchParams;
  const mine = params.get('mine') === '1';
  const kindParam = params.get('kind');
  const campaignSlug = params.get('campaign');

  const filter: { playerUserId?: string; kind?: CharacterKind } = {};
  if (mine) filter.playerUserId = session.userId;
  if (kindParam && KINDS.has(kindParam as CharacterKind)) {
    filter.kind = kindParam as CharacterKind;
  }

  let rows = listCharacters(session.currentGroupId, filter);
  if (campaignSlug) {
    rows = rows.filter((r) => r.campaigns.includes(campaignSlug));
  }
  return json({ characters: rows satisfies CharacterListRow[] });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
