// Review state for the Wrap-up dialog: what the closer ticked and which
// uncertain matches they switched to a new Note. Pure, so the grouping
// and the decisions sent to /api/sessions/wrap-up/apply are testable
// without a DOM. Type-only imports: lib/wrap-up pulls in the database.

import type { Mention, WrapUpProposal } from '@/lib/wrap-up';

export type ReviewChoice = { accepted: boolean; asNew: boolean };
export type ReviewState = ReadonlyMap<string, ReviewChoice>;

export type Destination =
  | { type: 'new'; title: string; summary: string; switched: boolean }
  | { type: 'existing'; path: string; certain: boolean };

export type ReviewRow = { mention: Mention; accepted: boolean; destination: Destination };

export const KIND_LABEL: Record<Mention['kind'], string> = {
  person: 'Person',
  creature: 'Creature',
  location: 'Location',
  item: 'Item',
  quest: 'Quest',
  lore: 'Lore',
};

/** Every mention ticked, every match as proposed. */
export function initialReview(proposal: WrapUpProposal): ReviewState {
  return new Map(proposal.mentions.map((m) => [m.id, { accepted: true, asNew: false }]));
}

export function setAccepted(state: ReviewState, id: string, accepted: boolean): ReviewState {
  return update(state, id, (c) => ({ ...c, accepted }));
}

export function setAsNew(state: ReviewState, id: string, asNew: boolean): ReviewState {
  return update(state, id, (c) => ({ ...c, asNew }));
}

function update(
  state: ReviewState,
  id: string,
  change: (c: ReviewChoice) => ReviewChoice,
): ReviewState {
  const current = state.get(id);
  if (!current) return state;
  return new Map(state).set(id, change(current));
}

/** Splits the proposal into the two review groups. A match the closer
 *  switched to new moves from History to New notes. */
export function groupRows(
  proposal: WrapUpProposal,
  state: ReviewState,
): { fresh: ReviewRow[]; history: ReviewRow[] } {
  const fresh: ReviewRow[] = [];
  const history: ReviewRow[] = [];
  for (const mention of proposal.mentions) {
    const choice = state.get(mention.id) ?? { accepted: true, asNew: false };
    const match = mention.match;
    if (match.type === 'new') {
      fresh.push({
        mention,
        accepted: choice.accepted,
        destination: { type: 'new', title: match.title, summary: match.summary, switched: false },
      });
    } else if (choice.asNew) {
      fresh.push({
        mention,
        accepted: choice.accepted,
        destination: { type: 'new', title: mention.name, summary: '', switched: true },
      });
    } else {
      history.push({
        mention,
        accepted: choice.accepted,
        destination: { type: 'existing', path: match.path, certain: match.certain },
      });
    }
  }
  return { fresh, history };
}

export function acceptedCount(state: ReviewState): number {
  let n = 0;
  for (const c of state.values()) if (c.accepted) n++;
  return n;
}

/** The body for /api/sessions/wrap-up/apply. */
export function toDecisions(state: ReviewState): { accepted: string[]; asNew: string[] } {
  const accepted: string[] = [];
  const asNew: string[] = [];
  for (const [id, choice] of state) {
    if (!choice.accepted) continue;
    accepted.push(id);
    if (choice.asNew) asNew.push(id);
  }
  return { accepted, asNew };
}
