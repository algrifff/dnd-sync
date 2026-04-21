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
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={ariaLabel ?? 'Edit'}
        className={`text-left hover:outline hover:outline-1 hover:outline-offset-2 hover:outline-[#D4C7AE] rounded ${className ?? ''}`}
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
    // No click-chrome: transparent bg, no border, no padding — so the
    // input sits in place of the button with zero visual shift. Width
    // comes from the multiline branch below (w-full on textarea) or
    // the consumer's inputClassName for singleline; default to 100%
    // of the parent the button occupied via min-w-0 + intrinsic size.
    className: `border-0 bg-transparent p-0 outline-none focus:outline-none focus:ring-0 ${
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
