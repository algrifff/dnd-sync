import { describe, expect, it } from 'bun:test';
import type { WrapUpProposal } from '@/lib/wrap-up';
import {
  acceptedCount,
  groupRows,
  initialReview,
  itemsLabel,
  setAccepted,
  setAsNew,
  toDecisions,
} from './wrap-up-review';

const proposal: WrapUpProposal = {
  sessionPath: 'Campaigns/Ashfall/Adventure Log/s.md',
  generatedAt: 1,
  mentions: [
    { id: 'm1', name: 'Bram', kind: 'person', match: { type: 'existing', path: 'People/bram.md', certain: true }, historyEntry: 'Gave the key.' },
    { id: 'm2', name: 'the innkeeper', kind: 'person', match: { type: 'existing', path: 'People/marta.md', certain: false }, historyEntry: 'Poured ale.' },
    { id: 'm3', name: 'Rusted Key', kind: 'item', match: { type: 'new', title: 'Rusted Key', summary: 'Iron.' }, historyEntry: 'Found.' },
  ],
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
