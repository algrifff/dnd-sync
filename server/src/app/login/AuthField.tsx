// Shared text input for the auth surface. Draws directly on the
// background in the sheet-header style: no border, no bg, a 2px
// bottom-stroke underline that lights up in candlelight on focus.
// Labels stack above each field in small caps so the underline strokes
// read as staves, not a form.

import type { HTMLInputTypeAttribute, Ref } from 'react';

type AuthFieldProps = {
  label: string;
  name: string;
  type?: HTMLInputTypeAttribute;
  autoComplete?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  autoFocus?: boolean;
  hint?: string;
  inputRef?: Ref<HTMLInputElement>;
};

export function AuthField({
  label,
  name,
  type = 'text',
  autoComplete,
  placeholder,
  defaultValue,
  required = true,
  autoFocus = false,
  hint,
  inputRef,
}: AuthFieldProps) {
  return (
    <label className="block auth-fade">
      <span className="block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ink-soft)]">
        {label}
      </span>
      <input
        ref={inputRef}
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        defaultValue={defaultValue}
        required={required}
        autoFocus={autoFocus}
        className="mt-1.5 w-full bg-transparent border-0 border-b-2 border-[var(--ink-muted)] px-0 py-2 text-[17px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] outline-none transition-colors duration-150 hover:border-[var(--ink-soft)] focus:border-[var(--candlelight)] focus:outline-0 focus-visible:outline-0 focus:ring-0"
        style={{ fontFamily: '"Fraunces", Georgia, serif' }}
      />
      {hint && <span className="mt-1 block text-xs text-[var(--ink-muted)]">{hint}</span>}
    </label>
  );
}
