'use client';

// Text that turns into an input when focused. Commits on blur or Enter,
// reverts on Escape. Used for name, tagline, region, etc.

import { useEffect, useRef, useState } from 'react';

export function InlineText({
  value,
  placeholder,
  readOnly,
  className,
  inputClassName,
  multiline,
  onCommit,
  maxLength,
  ariaLabel,
}: {
  value: string;
  placeholder?: string | undefined;
  readOnly?: boolean | undefined;
  className?: string | undefined;
  inputClassName?: string | undefined;
  multiline?: boolean | undefined;
  onCommit: (next: string) => void;
  maxLength?: number | undefined;
  ariaLabel?: string | undefined;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select?.();
    }
  }, [editing]);

  if (readOnly) {
    return (
      <span className={className}>
        {value || <span className="text-[#8A7E6B]">{placeholder ?? '—'}</span>}
      </span>
    );
  }

  if (!editing) {
    // min-w-[4ch] guarantees a click target even for single-character
    // values; border-b-2 transparent reserves space so the hover
    // underline doesn't shift layout when it appears.
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={ariaLabel ?? 'Edit'}
        className={`text-left min-w-[4ch] border-b-2 border-transparent hover:border-[var(--world-accent,#8A7E6B)] ${className ?? ''}`}
      >
        {value || <span className="text-[#8A7E6B]">{placeholder ?? 'Click to edit'}</span>}
      </button>
    );
  }

  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next !== value) onCommit(next);
  };
  const cancel = (): void => {
    setDraft(value);
    setEditing(false);
  };

  const sharedProps = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    },
    maxLength,
    // Bottom-stroke-only chrome in the world accent colour: kills the
    // full-border UA style, reserves 2px with a transparent bottom so
    // there's no layout pop on focus, and lights up the underline on
    // focus. outline-0 on top of outline-none belts-and-braces the
    // browser focus ring.
    className: `bg-transparent p-0 border-0 border-b-2 border-transparent focus:border-[var(--world-accent,#8A7E6B)] outline-none focus:outline-0 focus-visible:outline-0 focus:ring-0 ${
      multiline ? 'w-full' : 'min-w-0'
    } ${inputClassName ?? ''}`,
    'aria-label': ariaLabel ?? 'Edit',
  };

  if (multiline) {
    return (
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        rows={2}
        {...sharedProps}
      />
    );
  }
  return <input ref={inputRef as React.RefObject<HTMLInputElement>} {...sharedProps} />;
}
