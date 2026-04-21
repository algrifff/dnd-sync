'use client';

// Very simple note-path input: free text with a gentle validation
// hint. Header slots call this for location_path, parent_path, etc.
// Typeahead over existing notes is a follow-up — today the user just
// types the path (or pastes it from the sidebar).

import { InlineText } from './InlineText';

export function PathPicker({
  value,
  readOnly,
  onCommit,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string | null | undefined;
  readOnly?: boolean | undefined;
  onCommit: (next: string | null) => void;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <InlineText
      value={value ?? ''}
      readOnly={readOnly}
      className={className}
      placeholder={placeholder ?? 'e.g. Places/bree'}
      onCommit={(next) => onCommit(next === '' ? null : next)}
      ariaLabel={ariaLabel ?? 'Edit path'}
      maxLength={512}
    />
  );
}
