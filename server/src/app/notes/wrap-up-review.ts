// Review state for the Wrap-up dialog: what the closer ticked, which
// uncertain matches they switched to a new Note and which new Notes they
// pointed at a similarly named existing one. Pure, so the grouping
// and the decisions sent to /api/sessions/wrap-up/apply are testable
// without a DOM. Type-only imports: lib/wrap-up pulls in the database.

import { RELATIONS } from '@compendium/shared';
import type { Mention, Relation, StoredEndpoint, WrapUpProposal } from '@/lib/wrap-up';

export type ReviewChoice = {
  accepted: boolean;
  asNew: boolean;
  /** Path of an existing Note chosen in place of the mention's own
   *  match (a new Note, or an uncertain match). Wins over `asNew`. */
  useExisting: string | null;
};
export type ReviewState = ReadonlyMap<string, ReviewChoice>;

export type Destination =
  | { type: 'new'; title: string; summary: string; switched: boolean }
  | { type: 'existing'; path: string; certain: boolean; chosen: boolean };

export type ReviewRow = { mention: Mention; accepted: boolean; destination: Destination };

/** The Relationships the closer unticked. A Relationship is ticked unless
 *  it is in here, and whether it is *in effect* also depends on its
 *  mentions (see `relationRows`), so re-ticking a mention brings back
 *  the Relationships it took with it. */
export type RelationReview = ReadonlySet<string>;

export type RelationRow = {
  relation: Relation;
  /** The Note at each end, as the closer sees it in the other groups. */
  from: string;
  to: string;
  /** "works for": the type read from `from` to `to`. */
  label: string;
  /** Reads the same from either end ("ally of"). */
  symmetric: boolean;
  /** Ticked, and every mention it depends on is ticked. */
  accepted: boolean;
  /** A mention it depends on is unticked. An `existing` end never blocks:
   *  it stays valid whatever the closer does to a mention of the same
   *  Note. */
  blocked: boolean;
  /** Which end is the unticked mention. */
  fromOff: boolean;
  toOff: boolean;
};

/** What the closer is told after an apply, for the banner. */
export type WrapUpOutcome = {
  applied: number;
  created: number;
  relationsAdded: number;
  relationsSkipped: number;
};

/** Every mention ticked, every match as proposed. */
export function initialReview(proposal: WrapUpProposal): ReviewState {
  return new Map(
    proposal.mentions.map((m) => [m.id, { accepted: true, asNew: false, useExisting: null }]),
  );
}

export function setAccepted(state: ReviewState, id: string, accepted: boolean): ReviewState {
  return update(state, id, (c) => ({ ...c, accepted }));
}

export function setAsNew(state: ReviewState, id: string, asNew: boolean): ReviewState {
  return update(state, id, (c) => ({ ...c, asNew }));
}

/** Sends the mention's History to the existing Note at `path`, or back to
 *  its own match with null. */
export function setUseExisting(state: ReviewState, id: string, path: string | null): ReviewState {
  return update(state, id, (c) => ({ ...c, useExisting: path }));
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
 *  switched to new moves from History to New notes; a new Note the closer
 *  pointed at an existing one moves the other way. */
export function groupRows(
  proposal: WrapUpProposal,
  state: ReviewState,
): { fresh: ReviewRow[]; history: ReviewRow[] } {
  const fresh: ReviewRow[] = [];
  const history: ReviewRow[] = [];
  for (const mention of proposal.mentions) {
    const choice = state.get(mention.id) ?? { accepted: true, asNew: false, useExisting: null };
    const match = mention.match;
    if (choice.useExisting) {
      history.push({
        mention,
        accepted: choice.accepted,
        destination: { type: 'existing', path: choice.useExisting, certain: true, chosen: true },
      });
    } else if (match.type === 'new') {
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
        destination: { type: 'existing', path: match.path, certain: match.certain, chosen: false },
      });
    }
  }
  return { fresh, history };
}

export function setRelationAccepted(
  off: RelationReview,
  id: string,
  accepted: boolean,
): RelationReview {
  const next = new Set(off);
  if (accepted) next.delete(id);
  else next.add(id);
  return next;
}

/** One row per Relationship, in the proposal's order. `titles` is the
 *  `existingTitles` the proposal came with. A mention end reads as the
 *  mention's row does: its new title, its matched Note once certain, else
 *  the name as written in the log. */
export function relationRows(
  proposal: WrapUpProposal,
  state: ReviewState,
  off: RelationReview,
  titles: Readonly<Record<string, string>>,
): RelationRow[] {
  const mentions = new Map(proposal.mentions.map((m) => [m.id, m]));
  const endName = (end: StoredEndpoint): string => {
    if (end.type === 'existing') return titles[end.path] ?? end.path;
    const mention = mentions.get(end.mentionId);
    if (!mention) return '(unknown)';
    const choice = state.get(mention.id);
    if (choice?.useExisting) return titles[choice.useExisting] ?? mention.name;
    const match = mention.match;
    if (match.type === 'new') return match.title;
    if (choice?.asNew || !match.certain) return mention.name;
    return titles[match.path] ?? mention.name;
  };
  const unticked = (end: StoredEndpoint): boolean => {
    if (end.type !== 'mention') return false;
    const mention = mentions.get(end.mentionId);
    return !mention || state.get(mention.id)?.accepted === false;
  };

  return proposal.relations.map((relation) => {
    const fromOff = unticked(relation.from);
    const toOff = unticked(relation.to);
    const blocked = fromOff || toOff;
    return {
      relation,
      from: endName(relation.from),
      to: endName(relation.to),
      label: RELATIONS[relation.relation].label,
      symmetric: RELATIONS[relation.relation].symmetric,
      accepted: !off.has(relation.id) && !blocked,
      blocked,
      fromOff,
      toOff,
    };
  });
}

/** The outcome the banner reports, from the apply response. */
export function outcomeFromApply(data: {
  applied: Array<{ created: boolean }>;
  relationsAdded: unknown[];
  relationsSkipped: unknown[];
}): WrapUpOutcome {
  return {
    applied: data.applied.length,
    created: data.applied.filter((a) => a.created).length,
    relationsAdded: data.relationsAdded.length,
    relationsSkipped: data.relationsSkipped.length,
  };
}

/** "Session closed. 4 Notes updated, 1 of them new. 3 Relationships
 *  recorded, 1 skipped." Relationships are mentioned only when there were
 *  any. Read aloud by the banner; sighted users get `doneChips`. */
export function doneMessage(outcome: WrapUpOutcome | null): string {
  if (!outcome) return 'Session closed.';
  const parts = ['Session closed.'];
  if (outcome.applied > 0) {
    const notes = `${outcome.applied} ${outcome.applied === 1 ? 'Note' : 'Notes'} updated`;
    const created = outcome.created > 0 ? `, ${outcome.created} of them new` : '';
    parts.push(`${notes}${created}.`);
  }
  const { relationsAdded: added, relationsSkipped: skipped } = outcome;
  if (added > 0) {
    parts.push(`${relationsLabel(added)} recorded${skipped > 0 ? `, ${skipped} skipped` : ''}.`);
  } else if (skipped > 0) {
    parts.push(`${relationsLabel(skipped)} skipped.`);
  }
  return parts.join(' ');
}

export type DoneChip = { key: 'updated' | 'created' | 'recorded' | 'skipped'; count: number };

/** The banner's figures, one per non-zero count, in reading order. */
export function doneChips(outcome: WrapUpOutcome | null): DoneChip[] {
  if (!outcome) return [];
  const all: DoneChip[] = [
    { key: 'updated', count: outcome.applied },
    { key: 'created', count: outcome.created },
    { key: 'recorded', count: outcome.relationsAdded },
    { key: 'skipped', count: outcome.relationsSkipped },
  ];
  return all.filter((c) => c.count > 0);
}

function relationsLabel(n: number): string {
  return `${n} ${n === 1 ? 'Relationship' : 'Relationships'}`;
}

/** Ids of the Relationships in effect, for the apply body. */
export function acceptedRelationIds(
  proposal: WrapUpProposal,
  state: ReviewState,
  off: RelationReview,
): string[] {
  return relationRows(proposal, state, off, {}).filter((r) => r.accepted).map((r) => r.relation.id);
}

/** "Rusted Key ×2, Rope": the items a Suggestion offers, one line. */
export function itemsLabel(items: ReadonlyArray<{ name: string; quantity: number }>): string {
  return items.map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name)).join(', ');
}

export function acceptedCount(state: ReviewState): number {
  let n = 0;
  for (const c of state.values()) if (c.accepted) n++;
  return n;
}

/** The body for /api/sessions/wrap-up/apply. `generatedAt` names the
 *  proposal the closer reviewed; the server refuses it if the pending
 *  proposal has since been replaced. */
export function applyRequestBody(
  sessionPath: string,
  proposal: WrapUpProposal,
  state: ReviewState,
  off: RelationReview = new Set(),
): {
  sessionPath: string;
  generatedAt: number;
  accepted: string[];
  asNew: string[];
  acceptedRelations: string[];
  useExisting: Record<string, string>;
} {
  return {
    sessionPath,
    generatedAt: proposal.generatedAt,
    ...toDecisions(state),
    acceptedRelations: acceptedRelationIds(proposal, state, off),
  };
}

/** The decisions half of the apply body. */
export function toDecisions(state: ReviewState): {
  accepted: string[];
  asNew: string[];
  useExisting: Record<string, string>;
} {
  const accepted: string[] = [];
  const asNew: string[] = [];
  const useExisting: Record<string, string> = {};
  for (const [id, choice] of state) {
    if (!choice.accepted) continue;
    accepted.push(id);
    if (choice.useExisting) useExisting[id] = choice.useExisting;
    else if (choice.asNew) asNew.push(id);
  }
  return { accepted, asNew, useExisting };
}
