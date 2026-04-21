// GET /api/compendium/search?kind=item&q=<query>
//
// Typeahead over the cross-world compendium (items / monsters / spells /
// classes / …). Used by the ItemHeader's CompendiumSearch to let a DM
// attach a canonical 5e item (Longsword, Potion of Healing, etc.) to a
// loot note so category, rarity, weapon damage, and modifiers get
// populated automatically.
//
// Scope: global entries (group_id IS NULL) plus homebrew scoped to the
// caller's active group. Limited to 10 hits to keep the popup quick.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  searchByName,
  type CompendiumKind,
} from '@/lib/compendium';

export const dynamic = 'force-dynamic';

const LIMIT = 10;

const ALLOWED_KINDS: ReadonlySet<CompendiumKind> = new Set<CompendiumKind>([
  'class',
  'subclass',
  'race',
  'background',
  'feat',
  'spell',
  'item',
  'monster',
  'condition',
]);

export type CompendiumSearchHit = {
  id: string;
  name: string;
  kind: CompendiumKind;
  /** Full entry data so callers can autofill fields without a second RTT. */
  data: unknown;
};
export type CompendiumSearchResponse = { results: CompendiumSearchHit[] };

export async function GET(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const kindRaw = (url.searchParams.get('kind') ?? '').toLowerCase();
  const q = (url.searchParams.get('q') ?? '').trim();

  if (!ALLOWED_KINDS.has(kindRaw as CompendiumKind)) {
    return Response.json(
      {
        error: 'invalid_kind',
        reason: 'kind must be one of ' + [...ALLOWED_KINDS].join(', '),
      },
      { status: 400 },
    );
  }
  const kind = kindRaw as CompendiumKind;

  // Empty query → return a stable alphabetical slice so the popup isn't
  // blank on focus. searchByName with an empty string matches everything.
  const entries = searchByName({
    ruleset: 'dnd5e',
    kind,
    query: q,
    groupId: session.currentGroupId,
    limit: LIMIT,
  });

  const results: CompendiumSearchHit[] = entries.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    data: e.data,
  }));

  return Response.json({ results } satisfies CompendiumSearchResponse);
}
