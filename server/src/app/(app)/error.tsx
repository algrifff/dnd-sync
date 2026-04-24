'use client';

import { useEffect } from 'react';
import { trackError } from '@/lib/analytics/client';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    trackError(error, { scope: 'app-route', digest: error.digest ?? null });
  }, [error]);

  return (
    <div
      style={{
        padding: '2rem',
        maxWidth: 520,
        margin: '4rem auto',
        fontFamily: 'Georgia, serif',
        color: 'var(--ink, #3b2f1e)',
      }}
    >
      <h2 style={{ fontSize: '1.35rem', marginBottom: '0.5rem' }}>
        This page tripped a rune.
      </h2>
      <p style={{ lineHeight: 1.5, marginBottom: '1.25rem', opacity: 0.8 }}>
        The rest of the app is still up — you can try this page again or go
        back to the dashboard.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          onClick={reset}
          style={{
            padding: '0.5rem 1rem',
            background: 'var(--world-accent, var(--ink-muted))',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
        <a
          href="/home"
          style={{
            padding: '0.5rem 1rem',
            border: '1px solid currentColor',
            borderRadius: 4,
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          Home
        </a>
      </div>
    </div>
  );
}
