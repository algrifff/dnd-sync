'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ScrollText, X } from 'lucide-react';
import { broadcastTreeChange } from '@/lib/tree-sync';
import { EVENTS, track } from '@/lib/analytics/client';
import { WrapUpDialog } from './WrapUpDialog';
import { WrapUpDoneChips } from './WrapUpDoneChips';
import { doneMessage, type WrapUpOutcome } from './wrap-up-review';
import { REVIEW_PARAM, WRAP_UP_CHANGED_EVENT } from '../wrap-up-inbox';

export function EndSessionButton({
  sessionPath,
  csrfToken,
  isAlreadyClosed,
  hasPendingWrapUp,
  campaignSlug,
}: {
  sessionPath: string;
  csrfToken: string;
  isAlreadyClosed: boolean;
  /** A proposal is waiting: the button invites review instead. */
  hasPendingWrapUp: boolean;
  campaignSlug: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ outcome: WrapUpOutcome | null } | null>(null);

  // Arrived from the header's Wrap-up notice (`?review=1`): open the
  // review straight away and drop the flag so a reload doesn't reopen it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(REVIEW_PARAM)) return;
    url.searchParams.delete(REVIEW_PARAM);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    if (hasPendingWrapUp) setOpen(true);
  }, [sessionPath, hasPendingWrapUp]);

  function handleDone(outcome: WrapUpOutcome | null): void {
    track(EVENTS.END_SESSION_CONFIRMED, {
      session_path: sessionPath,
      campaign_slug: campaignSlug ?? null,
      was_already_closed: isAlreadyClosed,
    });
    setOpen(false);
    setDone({ outcome });
    window.dispatchEvent(new Event(WRAP_UP_CHANGED_EVENT));
    router.refresh();
    if (outcome && outcome.created > 0) broadcastTreeChange();
  }

  if (done) {
    return (
      <div
        role="status"
        className="wu-banner mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-[var(--wine)]/30 bg-[rgb(var(--wine-rgb)/0.08)] py-2 pl-3 pr-2"
      >
        <span className="sr-only">{doneMessage(done.outcome)}</span>
        <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--wine)] text-[var(--wu-on-wine)]">
          <Check size={15} strokeWidth={3} />
        </span>
        <span aria-hidden className="text-sm font-medium text-[var(--ink)]">
          Session closed
        </span>
        <WrapUpDoneChips outcome={done.outcome} />
        <button
          type="button"
          onClick={() => setDone(null)}
          aria-label="Dismiss"
          className="ml-auto grid h-9 w-9 place-items-center rounded-[8px] text-[var(--ink-soft)] transition hover:bg-[rgb(var(--wine-rgb)/0.12)] active:scale-95"
        >
          <X size={15} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          track(EVENTS.END_SESSION_CLICKED, {
            session_path: sessionPath,
            campaign_slug: campaignSlug ?? null,
            was_already_closed: isAlreadyClosed,
          });
          setOpen(true);
        }}
        className="mb-5 inline-flex items-center gap-2 rounded-[8px] bg-[var(--wine)] px-4 py-2 text-sm font-medium text-[var(--wu-on-wine)] shadow-[0_1px_0_rgb(var(--ink-rgb)/0.2)] transition hover:brightness-110 active:scale-[0.97]"
      >
        <ScrollText size={15} aria-hidden />
        {hasPendingWrapUp ? 'Review Wrap-up' : isAlreadyClosed ? 'Wrap up again' : 'End of Session'}
        {hasPendingWrapUp && (
          <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--candlelight)]" />
        )}
      </button>
      {open && (
        <WrapUpDialog
          sessionPath={sessionPath}
          csrfToken={csrfToken}
          isClosed={isAlreadyClosed}
          onClose={() => setOpen(false)}
          onDone={handleDone}
        />
      )}
    </>
  );
}
