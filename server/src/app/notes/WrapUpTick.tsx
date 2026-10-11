'use client';

import { Link2Off } from 'lucide-react';

/** The review's checkbox. The native input stays (keyboard, form state,
 *  screen readers); the box is drawn beside it. A `blocked` box shows a
 *  broken link in place of the tick. */
export function WrapUpTick({
  label,
  checked,
  disabled,
  blocked = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  blocked?: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <span className="wu-tick">
      <input
        type="checkbox"
        className="wu-tick__input"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="wu-tick__box" data-blocked={blocked} aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            className="wu-tick__check"
            d="M3 7.4 5.9 10.2 11 4.4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <Link2Off size={12} className="wu-tick__off" strokeWidth={2.25} />
      </span>
    </span>
  );
}
