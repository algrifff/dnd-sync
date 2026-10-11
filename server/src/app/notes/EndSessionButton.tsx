'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { broadcastTreeChange } from '@/lib/tree-sync';
import { EVENTS, track } from '@/lib/analytics/client';
import { WrapUpDialog, type WrapUpOutcome } from './WrapUpDialog';

export function EndSessionButton({
  sessionPath,
  csrfToken,
  isAlreadyClosed,
  campaignSlug,
}: {
  sessionPath: string;
  csrfToken: string;
  isAlreadyClosed: boolean;
  campaignSlug: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ outcome: WrapUpOutcome | null } | null>(null);

  function handleDone(outcome: WrapUpOutcome | null): void {
    track(EVENTS.END_SESSION_CONFIRMED, {
      session_path: sessionPath,
      campaign_slug: campaignSlug ?? null,
      was_already_closed: isAlreadyClosed,
    });
    setOpen(false);
    setDone({ outcome });
    router.refresh();
    if (outcome && outcome.created > 0) broadcastTreeChange();
  }

  if (done) {
    return (
      <div
        role="status"
        className="mb-5 rounded-[6px] border border-[var(--wine)]/30 bg-[var(--wine)]/8 px-4 py-3"
      >
        <p className="text-sm text-[var(--ink)]">{doneMessage(done.outcome)}</p>
        <button
          type="button"
          onClick={() => setDone(null)}
          className="mt-1 text-xs text-[var(--wine)] underline underline-offset-2 hover:opacity-70"
        >
          Dismiss
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
        className="mb-5 rounded-[4px] bg-[var(--wine)] px-4 py-2 text-sm font-medium text-[var(--parchment)] transition-opacity hover:opacity-85 active:opacity-70"
      >
        {isAlreadyClosed ? 'Wrap up again' : 'End of Session'}
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

function doneMessage(outcome: WrapUpOutcome | null): string {
  if (!outcome || outcome.applied === 0) return 'Session closed.';
  const notes = `${outcome.applied} ${outcome.applied === 1 ? 'Note' : 'Notes'} updated`;
  const created = outcome.created > 0 ? `, ${outcome.created} of them new` : '';
  return `Session closed. ${notes}${created}.`;
}
