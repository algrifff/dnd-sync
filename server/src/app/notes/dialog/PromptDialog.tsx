'use client';

// Shared single-field input dialog — the on-brand replacement for native
// window.prompt(). Same chrome family as ConfirmDialog (see that file):
// header with title + close, a description, a text input, an error
// banner, Cancel / Submit. Focus trap + auto-focus + focus restore come
// from useModalA11y.

import { useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useModalA11y } from './useModalA11y';

export function PromptDialog({
  titleId,
  title,
  description,
  label,
  initialValue = '',
  placeholder,
  submitLabel,
  submittingLabel,
  onSubmit,
  onClose,
}: {
  titleId: string;
  title: string;
  description?: React.ReactNode;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel: string;
  /** Defaults to `${submitLabel}…`. */
  submittingLabel?: string;
  /** Return a string to show as an error (dialog stays open); return
   *  nothing/undefined on success. Thrown errors are also caught. */
  onSubmit: (value: string) => Promise<string | void> | string | void;
  onClose: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState<string>(initialValue);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useModalA11y(containerRef, inputRef);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit(trimmed);
      if (typeof result === 'string' && result) {
        setError(result);
        setSubmitting(false);
      }
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
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="w-full max-w-sm rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_16px_48px_rgb(var(--ink-rgb)/0.3)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--rule)] px-4 py-3">
          <h3 id={titleId} className="text-sm font-semibold text-[var(--ink)]">
            {title}
          </h3>
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

        <div className="px-4 py-4">
          {description && (
            <p className="mb-3 text-xs text-[var(--ink-soft)]">{description}</p>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">
              {label}
            </span>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              disabled={submitting}
              maxLength={1024}
              className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)] disabled:opacity-60"
            />
          </label>
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
            type="submit"
            disabled={submitting || !value.trim()}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-semibold text-[var(--parchment)] transition hover:bg-[var(--vellum)] hover:text-[var(--ink)] disabled:opacity-50"
          >
            {submitting && <Loader2 size={12} className="animate-spin" aria-hidden />}
            {submitting ? (submittingLabel ?? `${submitLabel}…`) : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
