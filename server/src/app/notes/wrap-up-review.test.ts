import { describe, expect, it } from 'bun:test';
import type { WrapUpProposal } from '@/lib/wrap-up';
import {
  acceptedCount,
  acceptedRelationIds,
  doneMessage,
  groupRows,
  initialReview,
  itemsLabel,
  outcomeFromApply,
  relationRows,
  setAccepted,
  setAsNew,
  setRelationAccepted,
  toDecisions,
  applyRequestBody,
} from './wrap-up-review';

const proposal: WrapUpProposal = {
  sessionPath: 'Campaigns/Ashfall/Adventure Log/s.md',
  generatedAt: 1,
  mentions: [
    { id: 'm1', name: 'Bram', kind: 'person', match: { type: 'existing', path: 'People/bram.md', certain: true }, historyEntry: 'Gave the key.' },
    { id: 'm2', name: 'the innkeeper', kind: 'person', match: { type: 'existing', path: 'People/marta.md', certain: false }, historyEntry: 'Poured ale.' },
    { id: 'm3', name: 'Rusted Key', kind: 'item', match: { type: 'new', title: 'Rusted Key', summary: 'Iron.' }, historyEntry: 'Found.' },
  ],
  relations: [],
  suggestions: [],
};

describe('Wrap-up review state', () => {
  it('starts with every mention ticked and groups new Notes apart from History', () => {
    const { fresh, history } = groupRows(proposal, initialReview(proposal));

    expect(fresh.map((r) => r.mention.id)).toEqual(['m3']);
    expect(history.map((r) => r.mention.id)).toEqual(['m1', 'm2']);
    expect(acceptedCount(initialReview(proposal))).toBe(3);
  });

  it('moves an uncertain match to New notes when the closer switches it, and back', () => {
    const switched = setAsNew(initialReview(proposal), 'm2', true);

    const after = groupRows(proposal, switched);
    const back = groupRows(proposal, setAsNew(switched, 'm2', false));

    expect(after.fresh.map((r) => r.mention.id)).toEqual(['m2', 'm3']);
    expect(after.fresh[0]!.destination).toEqual({ type: 'new', title: 'the innkeeper', summary: '', switched: true });
    expect(back.history.map((r) => r.mention.id)).toEqual(['m1', 'm2']);
  });

  it('sends only the ticked mentions, and asNew only for those', () => {
    let state = setAsNew(initialReview(proposal), 'm2', true);
    state = setAccepted(state, 'm1', false);
    state = setAsNew(state, 'm3', true);
    state = setAccepted(state, 'm3', false);

    expect(toDecisions(state)).toEqual({ accepted: ['m2'], asNew: ['m2'] });
  });

  it('stamps the apply body with the generatedAt of the proposal that was reviewed', () => {
    const reviewed = { ...proposal, generatedAt: 1234 };
    const state = setAccepted(initialReview(reviewed), 'm1', false);

    expect(applyRequestBody(reviewed.sessionPath, reviewed, state)).toEqual({
      sessionPath: reviewed.sessionPath,
      generatedAt: 1234,
      accepted: ['m2', 'm3'],
      asNew: [],
      acceptedRelations: [],
    });
  });

  it('ignores a change for a mention the proposal does not hold', () => {
    const state = initialReview(proposal);

    expect(setAccepted(state, 'nope', false)).toBe(state);
  });
});

describe('itemsLabel', () => {
  it('lists items on one line and shows a quantity only above one', () => {
    const items = [{ name: 'Rusted Key', quantity: 2 }, { name: 'Rope', quantity: 1 }];

    expect(itemsLabel(items)).toBe('Rusted Key ×2, Rope');
  });
});

describe('Relationships in the Wrap-up review', () => {
  const withRelations: WrapUpProposal = {
    ...proposal,
    relations: [
      { id: 'r1', from: { type: 'mention', mentionId: 'm1' }, relation: 'works_for', to: { type: 'existing', path: 'Lore/guild.md' }, note: 'Said so.' },
      { id: 'r2', from: { type: 'mention', mentionId: 'm2' }, relation: 'owns', to: { type: 'mention', mentionId: 'm3' } },
      { id: 'r3', from: { type: 'existing', path: 'People/bram.md' }, relation: 'ally_of', to: { type: 'existing', path: 'Lore/guild.md' } },
    ],
  };
  const titles = { 'Lore/guild.md': 'The Guild', 'People/bram.md': 'Bram the Miller' };
  const none = new Set<string>();
  const rows = (state = initialReview(withRelations), off: ReadonlySet<string> = none) =>
    relationRows(withRelations, state, off, titles);

  it('lists one ticked row per relation, naming each end as its mention row does', () => {
    expect(rows().map((r) => [r.from, r.label, r.to, r.accepted])).toEqual([
      ['Bram the Miller', 'works for', 'The Guild', true],
      ['the innkeeper', 'owns', 'Rusted Key', true],
      ['Bram the Miller', 'ally of', 'The Guild', true],
    ]);
    expect(rows()[0]!.relation.note).toBe('Said so.');
  });

  it('names a switched-to-new match by the name in the log, and a certain match by its title', () => {
    const switched = setAsNew(initialReview(withRelations), 'm1', true);

    expect(rows(switched)[0]!.from).toBe('Bram');
    expect(rows(setAsNew(switched, 'm2', true))[1]!.from).toBe('the innkeeper');
    expect(relationRows(withRelations, initialReview(withRelations), none, {})[0]!.from).toBe('Bram');
  });

  it('unticks and blocks the relations that depend on an unticked mention, whichever end it is', () => {
    const state = setAccepted(initialReview(withRelations), 'm2', false);

    const after = rows(state);

    expect(after.map((r) => [r.accepted, r.blockedBy])).toEqual([[true, null], [false, 'the innkeeper'], [true, null]]);
    expect(acceptedRelationIds(withRelations, state, none)).toEqual(['r1', 'r3']);
  });

  it('brings a relation back, with its own tick, when the mention is ticked again', () => {
    const unticked = setAccepted(initialReview(withRelations), 'm1', false);
    const off = setRelationAccepted(none, 'r1', false);

    expect(rows(setAccepted(unticked, 'm1', true), off)[0]!.accepted).toBe(false);
    expect(rows(setAccepted(unticked, 'm1', true), setRelationAccepted(off, 'r1', true))[0]!.accepted).toBe(true);
  });

  it('lists only the mention ends as dependencies, so an existing end claims no skip rule', () => {
    const state = setAccepted(initialReview(withRelations), 'm1', false);

    expect(rows().map((r) => r.dependsOn)).toEqual([['Bram the Miller'], ['the innkeeper', 'Rusted Key'], []]);
    // Bram is both a mention (m1) and the existing end of r3: unticking m1 leaves r3 intact.
    expect(rows(state).map((r) => [r.dependsOn.length > 0, r.accepted])).toEqual([[true, false], [true, true], [false, true]]);
  });

  it('lets the closer untick a relation that depends on no mention', () => {
    const off = setRelationAccepted(none, 'r3', false);

    expect(rows(initialReview(withRelations), off).map((r) => r.accepted)).toEqual([true, true, false]);
    expect(none.size).toBe(0);
  });

  it('sends the ids of the relations in effect in the apply body', () => {
    const state = setAccepted(initialReview(withRelations), 'm1', false);
    const off = setRelationAccepted(none, 'r3', false);

    expect(applyRequestBody(withRelations.sessionPath, withRelations, state, off)).toEqual({
      sessionPath: withRelations.sessionPath,
      generatedAt: 1,
      accepted: ['m2', 'm3'],
      asNew: [],
      acceptedRelations: ['r2'],
    });
  });
});

describe('Wrap-up banner', () => {
  const out = (applied: number, created: number, relationsAdded: number, relationsSkipped: number) => ({
    applied, created, relationsAdded, relationsSkipped,
  });

  it('keeps the existing wording when there were no Relationships', () => {
    expect(doneMessage(null)).toBe('Session closed.');
    expect(doneMessage(out(0, 0, 0, 0))).toBe('Session closed.');
    expect(doneMessage(out(1, 0, 0, 0))).toBe('Session closed. 1 Note updated.');
    expect(doneMessage(out(4, 1, 0, 0))).toBe('Session closed. 4 Notes updated, 1 of them new.');
  });

  it('reports Relationships recorded, and skipped only when some were', () => {
    expect(doneMessage(out(4, 1, 3, 0))).toBe('Session closed. 4 Notes updated, 1 of them new. 3 Relationships recorded.');
    expect(doneMessage(out(4, 1, 3, 1))).toBe('Session closed. 4 Notes updated, 1 of them new. 3 Relationships recorded, 1 skipped.');
    expect(doneMessage(out(2, 0, 1, 0))).toBe('Session closed. 2 Notes updated. 1 Relationship recorded.');
  });

  it('reports Relationships even when no History entry landed', () => {
    expect(doneMessage(out(0, 0, 2, 0))).toBe('Session closed. 2 Relationships recorded.');
    expect(doneMessage(out(0, 0, 0, 1))).toBe('Session closed. 1 Relationship skipped.');
  });

  it('carries the Relationship counts from the apply response', () => {
    const data = {
      applied: [{ created: true }, { created: false }],
      relationsAdded: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      relationsSkipped: [{ id: 'r4' }],
    };

    expect(outcomeFromApply(data)).toEqual(out(2, 1, 3, 1));
  });
});
