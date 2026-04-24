'use client';

export function SaveIndicator({
  saving,
  error,
}: {
  saving: boolean;
  error: string | null;
}): React.JSX.Element {
  return (
    <span
      aria-live="polite"
      className="text-[11px] transition-opacity"
      style={{
        opacity: saving || error ? 1 : 0,
        color: error ? 'var(--wine)' : 'var(--ink-soft)',
      }}
    >
      {error ? error : saving ? 'Saving…' : ''}
    </span>
  );
}
