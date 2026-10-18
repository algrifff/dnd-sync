// The header's Wrap-up notice: pure helpers shared by `WrapUpInbox`
// and `EndSessionButton`.

import type { PendingWrapUp } from '@/lib/wrap-up';

/** Fired on window after a Wrap-up is applied or a Session closed, so
 *  the notice drops it without waiting for the next poll. */
export const WRAP_UP_CHANGED_EVENT = 'compendium:wrap-up-changed';

/** Query flag on a Session link that opens its review dialog on load. */
export const REVIEW_PARAM = 'review';

export function reviewHref(sessionPath: string): string {
  return `/notes/${sessionPath.split('/').map(encodeURIComponent).join('/')}?${REVIEW_PARAM}=1`;
}

/** "3 Notes · 2 Relationships · 1 Suggestion", skipping empty counts. */
export function pendingSummary(p: Pick<PendingWrapUp, 'mentions' | 'relations' | 'suggestions'>): string {
  const parts = [
    count(p.mentions, 'Note'),
    count(p.relations, 'Relationship'),
    count(p.suggestions, 'Suggestion'),
  ].filter((s): s is string => s !== null);
  return parts.length ? parts.join(' · ') : 'Nothing to add';
}

function count(n: number, noun: string): string | null {
  return n > 0 ? `${n} ${noun}${n === 1 ? '' : 's'}` : null;
}
