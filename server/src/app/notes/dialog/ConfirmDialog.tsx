'use client';

// Shared "are you sure?" dialog — the on-brand replacement for native
// window.confirm(). Extracted from CampaignDeleteDialog so folder/note
// delete (previously native confirm()) render the same chrome: title +
// optional warning icon, description, an optional decorative detail box
// (e.g. "12 notes across 4 folders will be deleted"), an error banner,
// and Cancel / Confirm buttons. Focus trap + auto-focus + focus restore
// come from useModalA11y — see that file for why there's no dependency.

import { useRef, useState } from 'react';
import { Loader2, X, AlertTriangle } from 'lucide-react';
import { useModalA11y } from './useModalA11y';

export function ConfirmDialog({
  titleId,
  title,
  description,
  detail,
  confirmLabel,
  confirmingLabel,
  tone = 'danger',
  onConfirm,
  onClose,
}: {
  titleId: string;
  title: string;
  description: React.ReactNode;
  /** Optional decorative box under the description — e.g. item counts. */
  detail?: React.ReactNode;
  confirmLabel: string;
  /** Label shown on the confirm button while `onConfirm` is in flight.
   *  Defaults to `${confirmLabel}…`. */
  confirmingLabel?: string;
  tone?: 'danger' | 'default';
  /** Return a string to show as an error (dialog stays open); return
   *  nothing/undefined on success (caller is expected to have already
   *  closed or navigated by then). Thrown errors are also caught and
   *  rendered the same way. */
  onConfirm: () => Promise<string | void> | string | void;
  onClose: () => void;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useModalA11y(containerRef, confirmBtnRef);

  const handleConfirm = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await onConfirm();
      if (typeof result === 'string' && result) {
        setError(result);
        setSubmitting(false);
      }
      // Falsy/void result = caller handled success (closed, navigated, …).
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/50 p-4"
      onClick={(e) => {
        if (!submitting && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_16px_48px_rgb(var(--ink-rgb)/0.3)]">
        <div className="flex items-center justify-between border-b border-[var(--rule)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {tone === 'danger' && (
              <AlertTriangle size={16} className="shrink-0 text-[var(--wine)]" aria-hidden />
            )}
            <h3 id={titleId} className="text-sm font-semibold text-[var(--ink)]">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)] disabled:opacity-40"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <div className="px-4 py-4 text-sm text-[var(--ink)]">
          {description}
          {detail}
          {error && (
            <p
              role="alert"
              className="mt-3 rounded-[6px] border border-[var(--wine)]/40 bg-[rgb(var(--wine-rgb)/0.08)] px-2 py-1.5 text-xs text-[var(--wine)]"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--rule)] bg-[var(--parchment-sunk)]/40 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={() => void handleConfirm()}
            disabled={submitting}
            className={
              'inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ' +
              (tone === 'danger'
                ? 'bg-[var(--wine)] text-[var(--vellum)] hover:opacity-90'
                : 'bg-[var(--ink)] text-[var(--parchment)] hover:bg-[var(--vellum)] hover:text-[var(--ink)]')
            }
          >
            {submitting && <Loader2 size={12} className="animate-spin" aria-hidden />}
            {submitting ? (confirmingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
