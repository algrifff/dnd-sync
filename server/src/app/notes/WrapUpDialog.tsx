'use client';

// Review step of a Wrap-up (docs/adr/0001-wrap-up-on-close.md). Loads the
// Session's pending proposal, lets the closer untick mentions and
// Relationships and switch uncertain matches to a new Note, then applies
// the rest. Nothing is
// written until "Apply". With no proposal yet it explains where one comes
// from: the Player's own Claude submits it.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { WrapUpProposal } from '@/lib/wrap-up';
import { EVENTS, track } from '@/lib/analytics/client';
import { useModalA11y } from './dialog/useModalA11y';
import {
  KIND_LABEL,
  acceptedCount,
  acceptedRelationIds,
  groupRows,
  initialReview,
  itemsLabel,
  relationRows,
  setAccepted,
  setAsNew,
  setRelationAccepted,
  applyRequestBody,
  type RelationReview,
  type RelationRow,
  type ReviewRow,
  type ReviewState,
} from './wrap-up-review';

export type WrapUpOutcome = { applied: number; created: number };

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; proposal: WrapUpProposal; titles: Record<string, string> };

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
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [review, setReview] = useState<ReviewState>(new Map());
  const [relationsOff, setRelationsOff] = useState<RelationReview>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        await fetchProposal('The proposal changed while you were reviewing it, so it has been reloaded. Review it again.');
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(await errorText(res));
      const data = (await res.json()) as { applied: Array<{ created: boolean }> };
      onDone({ applied: data.applied.length, created: data.applied.filter((a) => a.created).length });
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
      onDone(null);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/50 p-4"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_16px_48px_rgb(var(--ink-rgb)/0.3)]">
        <div className="flex items-center justify-between border-b border-[var(--rule)] px-4 py-3">
          <h3 id={titleId} className="text-sm font-semibold text-[var(--ink)]">
            {isClosed ? 'Wrap up this Session again' : 'End of Session'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-[6px] p-2 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)] disabled:opacity-40"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm text-[var(--ink)]">
          {load.status === 'loading' && (
            <p role="status" className="flex items-center gap-2 text-[var(--ink-soft)]">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Loading the Wrap-up…
            </p>
          )}

          {load.status === 'error' && (
            <p
              role="alert"
              className="rounded-[6px] border border-[var(--wine)]/40 bg-[rgb(var(--wine-rgb)/0.08)] px-3 py-2 text-xs text-[var(--wine)]"
            >
              {load.message}
            </p>
          )}

          {load.status === 'empty' && (
            <div className="space-y-2">
              <p className="font-medium">No Wrap-up has been proposed yet.</p>
              <p className="text-[var(--ink-soft)]">
                A Player&rsquo;s own Claude proposes the Wrap-up and submits it through the
                Compendium connector. Ask it to read this Session and submit a Wrap-up, then
                check again. You will see everything it proposes here and choose what to keep
                before anything is written.
              </p>
            </div>
          )}

          {ready && !hasReviewRows(ready.proposal) && ready.proposal.suggestions.length === 0 && (
            <p className="text-[var(--ink-soft)]">
              Claude found nothing new to add to your Notes from this Session.
            </p>
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

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-[6px] border border-[var(--wine)]/40 bg-[rgb(var(--wine-rgb)/0.08)] px-3 py-2 text-xs text-[var(--wine)]"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--rule)] bg-[var(--parchment-sunk)]/40 px-4 py-3">
          {(load.status === 'error' || load.status === 'empty') && (
            <button
              type="button"
              onClick={() => void fetchProposal()}
              disabled={busy}
              className="rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
            >
              Check again
            </button>
          )}
          {load.status === 'empty' && !isClosed && (
            <button
              type="button"
              onClick={() => void closeWithoutWrapUp()}
              disabled={busy}
              className="rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
            >
              Close without a Wrap-up
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
          >
            Cancel
          </button>
          {ready && (
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--wine)] px-3 py-2 text-xs font-semibold text-[var(--vellum)] transition hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
              {applyLabel(busy, selected, isClosed, ready.proposal.suggestions.length)}
            </button>
          )}
        </div>
      </div>
    </div>
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

function applyLabel(busy: boolean, selected: number, isClosed: boolean, suggestions: number): string {
  if (busy) return 'Applying…';
  if (selected > 0) return `Apply ${selected} selected`;
  if (suggestions > 0) return 'Send Suggestions';
  return isClosed ? 'Discard proposal' : 'Close without changes';
}

async function isProposalChanged(res: Response): Promise<boolean> {
  const data = (await res.clone().json().catch(() => ({}))) as { error?: string };
  return data.error === 'proposal_changed';
}

async function errorText(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  if (data.error === 'no_pending_proposal') {
    return 'This proposal was already applied or replaced. Check again.';
  }
  return data.reason ?? data.error ?? `Something went wrong (HTTP ${res.status}).`;
}

function ReviewList({
  proposal,
  titles,
  review,
  relationsOff,
  disabled,
  onChange,
  onRelationsChange,
}: {
  proposal: WrapUpProposal;
  titles: Record<string, string>;
  review: ReviewState;
  relationsOff: RelationReview;
  disabled: boolean;
  onChange: (next: ReviewState) => void;
  onRelationsChange: (next: RelationReview) => void;
}): React.JSX.Element {
  const { fresh, history } = groupRows(proposal, review);
  const relations = relationRows(proposal, review, relationsOff, titles);
  const freshId = useId();
  const historyId = useId();
  const relationsId = useId();

  const renderRow = (row: ReviewRow): React.JSX.Element => (
    <MentionRow
      key={row.mention.id}
      row={row}
      titles={titles}
      disabled={disabled}
      onToggle={(accepted) => onChange(setAccepted(review, row.mention.id, accepted))}
      onSwitch={(asNew) => onChange(setAsNew(review, row.mention.id, asNew))}
    />
  );

  return (
    <div className="space-y-5">
      {fresh.length > 0 && (
        <section aria-labelledby={freshId}>
          <h4 id={freshId} className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
            New notes ({fresh.length})
          </h4>
          <ul className="mt-2 space-y-1">{fresh.map(renderRow)}</ul>
        </section>
      )}
      {history.length > 0 && (
        <section aria-labelledby={historyId}>
          <h4 id={historyId} className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
            History ({history.length})
          </h4>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            Adds a dated entry to a Note that already exists.
          </p>
          <ul className="mt-2 space-y-1">{history.map(renderRow)}</ul>
        </section>
      )}
      {relations.length > 0 && (
        <section aria-labelledby={relationsId}>
          <h4 id={relationsId} className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
            Relationships ({relations.length})
          </h4>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            Records how two Notes relate. Skipped if either Note is not kept above.
          </p>
          <ul className="mt-2 space-y-1">
            {relations.map((row) => (
              <RelationshipRow
                key={row.relation.id}
                row={row}
                disabled={disabled}
                onToggle={(accepted) =>
                  onRelationsChange(setRelationAccepted(relationsOff, row.relation.id, accepted))
                }
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RelationshipRow({
  row,
  disabled,
  onToggle,
}: {
  row: RelationRow;
  disabled: boolean;
  onToggle: (accepted: boolean) => void;
}): React.JSX.Element {
  const blocked = row.blockedBy !== null;
  return (
    <li className="rounded-[6px] px-1 py-1.5 hover:bg-[var(--parchment)]">
      <label
        className={`flex min-w-0 items-start gap-3 py-0.5 ${blocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      >
        <input
          type="checkbox"
          checked={row.accepted}
          disabled={disabled || blocked}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--wine)]"
        />
        <span className="min-w-0">
          <span className="block font-medium text-[var(--ink)]">
            {row.from} <span className="font-normal text-[var(--ink-soft)]">→ {row.label} →</span> {row.to}
          </span>
          {row.relation.note && (
            <span className="block text-xs text-[var(--ink-soft)]">{row.relation.note}</span>
          )}
          {row.blockedBy !== null && (
            <span className="block text-xs text-[var(--ink-muted)]">Needs {row.blockedBy} above.</span>
          )}
        </span>
      </label>
    </li>
  );
}

/** Read-only: Suggestions are not the closer's to accept. Each goes to
 *  its Character's Player, who accepts or dismisses it. */
function SuggestionsNotice({
  proposal,
  titles,
}: {
  proposal: WrapUpProposal;
  titles: Record<string, string>;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-5">
      <h4 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
        Suggestions ({proposal.suggestions.length})
      </h4>
      <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
        Sent to each Character&rsquo;s Player to accept or dismiss. They never change game stats.
      </p>
      <ul className="mt-2 space-y-1">
        {proposal.suggestions.map((s) => (
          <li key={s.id} className="rounded-[6px] px-1 py-1.5">
            <span className="block font-medium text-[var(--ink)]">{titles[s.characterPath] ?? s.characterPath}</span>
            {s.story && <span className="block text-xs text-[var(--ink-soft)]">{s.story}</span>}
            {s.items.length > 0 && (
              <span className="block text-xs text-[var(--ink-soft)]">Items: {itemsLabel(s.items)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MentionRow({
  row,
  titles,
  disabled,
  onToggle,
  onSwitch,
}: {
  row: ReviewRow;
  titles: Record<string, string>;
  disabled: boolean;
  onToggle: (accepted: boolean) => void;
  onSwitch: (asNew: boolean) => void;
}): React.JSX.Element {
  const { mention, destination } = row;
  const kind = KIND_LABEL[mention.kind];
  const matchedTitle =
    mention.match.type === 'existing'
      ? (titles[mention.match.path] ?? mention.match.path)
      : null;
  const uncertain =
    mention.match.type === 'existing' && !mention.match.certain;
  const heading =
    destination.type === 'new' ? destination.title : uncertain ? mention.name : (matchedTitle ?? mention.name);

  return (
    <li className="flex items-start gap-2 rounded-[6px] px-1 py-1.5 hover:bg-[var(--parchment)]">
      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 py-0.5">
        <input
          type="checkbox"
          checked={row.accepted}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--wine)]"
        />
        <span className="min-w-0">
          <span className="block font-medium text-[var(--ink)]">
            {heading} <span className="font-normal text-[var(--ink-soft)]">· {kind}</span>
          </span>
          {uncertain && destination.type === 'existing' && (
            <span className="block text-xs font-medium text-[var(--wine)]">Matched to {matchedTitle}?</span>
          )}
          {destination.type === 'new' && destination.summary && (
            <span className="block text-xs text-[var(--ink-soft)]">{destination.summary}</span>
          )}
          <span className="block text-xs text-[var(--ink-soft)]">{mention.historyEntry}</span>
        </span>
      </label>
      {uncertain && matchedTitle && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSwitch(destination.type !== 'new')}
          className="shrink-0 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2.5 py-2 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
        >
          {destination.type === 'new' ? `Matched to ${matchedTitle}?` : `New ${kind}`}
          <span className="sr-only"> for {mention.name}</span>
        </button>
      )}
    </li>
  );
}
