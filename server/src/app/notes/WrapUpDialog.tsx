'use client';

// Review step of a Wrap-up (docs/adr/0001-wrap-up-on-close.md). Loads the
// Session's pending proposal, lets the closer untick mentions and
// Relationships and switch uncertain matches to a new Note, then applies
// the rest. Nothing is written until "Apply".

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Feather, Loader2, RefreshCw, ScrollText, Sparkles, X, type LucideIcon } from 'lucide-react';
import type { WrapUpProposal } from '@/lib/wrap-up';
import { EVENTS, track } from '@/lib/analytics/client';
import { useModalA11y } from './dialog/useModalA11y';
import { ReviewList, SuggestionsNotice } from './WrapUpRows';
import { WrapUpDoneChips } from './WrapUpDoneChips';
import {
  acceptedCount,
  acceptedRelationIds,
  applyRequestBody,
  doneMessage,
  initialReview,
  outcomeFromApply,
  type RelationReview,
  type ReviewState,
  type WrapUpOutcome,
} from './wrap-up-review';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; proposal: WrapUpProposal; titles: Record<string, string> };

const QUIET_BUTTON =
  'rounded-[8px] px-3 py-2 text-sm font-medium text-[var(--ink-soft)] transition hover:bg-[var(--parchment)] hover:text-[var(--ink)] active:scale-[0.97] disabled:opacity-40';
const OUTLINE_BUTTON =
  'inline-flex items-center gap-1.5 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition hover:bg-[var(--parchment-sunk)] active:scale-[0.97] disabled:opacity-40';

export function WrapUpDialog({
  sessionPath,
  csrfToken,
  isClosed,
  onClose,
  onDone,
}: {
  sessionPath: string;
  csrfToken: string;
  isClosed: boolean;
  onClose: () => void;
  /** `null` when the Session was closed without a Wrap-up. */
  onDone: (outcome: WrapUpOutcome | null) => void;
}): React.JSX.Element {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [review, setReview] = useState<ReviewState>(new Map());
  const [relationsOff, setRelationsOff] = useState<RelationReview>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sealed, setSealed] = useState<{ outcome: WrapUpOutcome | null; height: number } | null>(null);

  useModalA11y(containerRef);

  const fetchProposal = useCallback(async (notice?: string): Promise<void> => {
    setLoad({ status: 'loading' });
    setError(null);
    try {
      const res = await fetch(
        `/api/sessions/wrap-up?sessionPath=${encodeURIComponent(sessionPath)}`,
        { credentials: 'same-origin' },
      );
      if (!res.ok) throw new Error(await errorText(res));
      const data = (await res.json()) as {
        proposal: WrapUpProposal | null;
        existingTitles: Record<string, string>;
      };
      if (data.proposal) {
        setReview(initialReview(data.proposal));
        setRelationsOff(new Set());
        setLoad({ status: 'ready', proposal: data.proposal, titles: data.existingTitles });
      } else {
        setLoad({ status: 'empty' });
      }
      if (notice) setError(notice);
    } catch (err) {
      setLoad({ status: 'error', message: err instanceof Error ? err.message : 'Could not load the proposal.' });
    }
  }, [sessionPath]);

  useEffect(() => {
    void fetchProposal();
  }, [fetchProposal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
  }

  /** Holds the seal on screen for a beat, then hands over to the page. */
  async function seal(outcome: WrapUpOutcome | null): Promise<void> {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setSealed({ outcome, height: panelRef.current?.offsetHeight ?? 0 });
    await new Promise((resolve) => setTimeout(resolve, still ? 700 : 1150));
    onDone(outcome);
  }

  async function apply(): Promise<void> {
    if (load.status !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      const res = await post(
        '/api/sessions/wrap-up/apply',
        applyRequestBody(sessionPath, load.proposal, review, relationsOff),
      );
      if (res.status === 409 && (await isProposalChanged(res))) {
        await fetchProposal('Proposal changed.');
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(await errorText(res));
      await seal(outcomeFromApply(await res.json()));
    } catch (err) {
      trackFailure(sessionPath, err);
      setError(err instanceof Error ? err.message : 'Could not apply the Wrap-up.');
      setBusy(false);
    }
  }

  async function closeWithoutWrapUp(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await post('/api/sessions/mark-closed', { sessionPath });
      if (!res.ok) throw new Error(await errorText(res));
      await seal(null);
    } catch (err) {
      trackFailure(sessionPath, err);
      setError(err instanceof Error ? err.message : 'Could not close the Session.');
      setBusy(false);
    }
  }

  const ready = load.status === 'ready' ? load : null;
  const selected = ready
    ? acceptedCount(review) + acceptedRelationIds(ready.proposal, review, relationsOff).length
    : 0;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="wu-overlay fixed inset-0 z-50 flex items-end justify-center bg-[var(--ink)]/50 sm:items-center sm:p-4"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        style={sealed ? { height: sealed.height } : undefined}
        className="wu-panel flex max-h-[92dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-[18px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_16px_48px_rgb(var(--ink-rgb)/0.3)] sm:max-h-[85vh] sm:rounded-[14px]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--rule)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[rgb(var(--wine-rgb)/0.14)] text-[var(--wine)]"
              aria-hidden
            >
              <ScrollText size={16} />
            </span>
            <h3 id={titleId} className="truncate font-serif text-base font-semibold text-[var(--ink)]">
              {isClosed ? 'Wrap up this Session again' : 'End of Session'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] text-[var(--ink-soft)] transition hover:bg-[var(--parchment)] active:scale-95 disabled:opacity-40"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {sealed ? (
          <div role="status" className="wu-overlay flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-4 py-10">
            <span className="wu-seal" aria-hidden>
              <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                <path d="M7 15.5 13 21.5 23.5 9" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <WrapUpDoneChips outcome={sealed.outcome} />
            <span className="sr-only">{doneMessage(sealed.outcome)}</span>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 text-sm text-[var(--ink)]">
              {load.status === 'loading' && <LoadingRows />}

              {load.status === 'error' && <Alert className="mt-4">{load.message}</Alert>}

              {load.status === 'empty' && (
                <Placeholder Icon={Feather} label="No Wrap-up yet" />
              )}

              {ready && !hasReviewRows(ready.proposal) && ready.proposal.suggestions.length === 0 && (
                <Placeholder Icon={Sparkles} label="Nothing new" />
              )}

              {ready && hasReviewRows(ready.proposal) && (
                <ReviewList
                  proposal={ready.proposal}
                  titles={ready.titles}
                  review={review}
                  relationsOff={relationsOff}
                  disabled={busy}
                  onChange={setReview}
                  onRelationsChange={setRelationsOff}
                />
              )}

              {ready && ready.proposal.suggestions.length > 0 && (
                <SuggestionsNotice proposal={ready.proposal} titles={ready.titles} />
              )}

              {error && <Alert className="mt-3">{error}</Alert>}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--rule)] bg-[var(--parchment-sunk)]/40 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {(load.status === 'error' || load.status === 'empty') && (
                <button type="button" onClick={() => void fetchProposal()} disabled={busy} className={OUTLINE_BUTTON}>
                  <RefreshCw size={14} aria-hidden />
                  Check again
                </button>
              )}
              {load.status === 'empty' && !isClosed && (
                <button type="button" onClick={() => void closeWithoutWrapUp()} disabled={busy} className={OUTLINE_BUTTON}>
                  Close without a Wrap-up
                </button>
              )}
              <button type="button" onClick={onClose} disabled={busy} className={QUIET_BUTTON}>
                Cancel
              </button>
              {ready && (
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={busy}
                  className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-[8px] bg-[var(--wine)] px-4 py-2 text-sm font-semibold text-[var(--wu-on-wine)] shadow-[0_1px_0_rgb(var(--ink-rgb)/0.2)] transition hover:brightness-110 active:scale-[0.97] disabled:opacity-60 sm:flex-none"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} strokeWidth={3} aria-hidden />}
                  <ApplyLabel busy={busy} selected={selected} isClosed={isClosed} suggestions={ready.proposal.suggestions.length} />
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ApplyLabel({
  busy,
  selected,
  isClosed,
  suggestions,
}: {
  busy: boolean;
  selected: number;
  isClosed: boolean;
  suggestions: number;
}): React.JSX.Element {
  if (busy) return <span>Applying</span>;
  if (selected > 0) {
    return (
      <>
        <span>Apply</span>
        <span key={selected} className="wu-num tabular-nums">{selected}</span>
      </>
    );
  }
  if (suggestions > 0) return <span>Send Suggestions</span>;
  return <span>{isClosed ? 'Discard proposal' : 'Close without changes'}</span>;
}

function LoadingRows(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading" className="space-y-3 pt-4">
      {[72, 56, 64, 48].map((w, i) => (
        <div key={i} className="flex items-center gap-3 motion-safe:animate-pulse" style={{ animationDelay: `${i * 90}ms` }}>
          <span className="h-[22px] w-[22px] rounded-[7px] bg-[var(--parchment-sunk)]" />
          <span className="h-8 w-8 rounded-[9px] bg-[var(--parchment-sunk)]" />
          <span className="space-y-1.5" style={{ width: `${w}%` }}>
            <span className="block h-3 w-full rounded bg-[var(--parchment-sunk)]" />
            <span className="block h-2.5 w-3/4 rounded bg-[var(--parchment-sunk)]" />
          </span>
        </div>
      ))}
    </div>
  );
}

function Placeholder({
  Icon,
  label,
}: {
  Icon: LucideIcon;
  label: string;
}): React.JSX.Element {
  return (
    <div className="wu-enter flex flex-col items-center gap-3 py-12 text-[var(--ink-muted)]">
      <span className="grid h-14 w-14 place-items-center rounded-full border-[1.5px] border-dashed border-[var(--ink-muted)]/60">
        <Icon size={22} strokeWidth={1.75} aria-hidden />
      </span>
      <p className="text-sm font-medium text-[var(--ink-soft)]">{label}</p>
    </div>
  );
}

function Alert({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <p
      role="alert"
      className={`rounded-[8px] border border-[var(--wine)]/40 bg-[rgb(var(--wine-rgb)/0.08)] px-3 py-2 text-xs text-[var(--wine)] ${className}`}
    >
      {children}
    </p>
  );
}

function hasReviewRows(proposal: WrapUpProposal): boolean {
  return proposal.mentions.length > 0 || proposal.relations.length > 0;
}

function trackFailure(sessionPath: string, err: unknown): void {
  track(EVENTS.END_SESSION_FAILED, {
    session_path: sessionPath,
    reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
  });
}

async function isProposalChanged(res: Response): Promise<boolean> {
  const data = (await res.clone().json().catch(() => ({}))) as { error?: string };
  return data.error === 'proposal_changed';
}

async function errorText(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  if (data.error === 'no_pending_proposal') return 'Already applied or replaced.';
  return data.reason ?? data.error ?? `Something went wrong (HTTP ${res.status}).`;
}
