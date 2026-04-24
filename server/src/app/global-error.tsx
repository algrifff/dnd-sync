'use client';

import { useEffect } from 'react';
import { trackError } from '@/lib/analytics/client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    trackError(error, { scope: 'global', digest: error.digest ?? null });
  }, [error]);

  return (
    <html>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f4ecd8',
          color: '#3b2f1e',
          fontFamily: 'Georgia, serif',
          padding: '2rem',
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.75rem', marginBottom: '0.75rem' }}>
            The ink ran dry.
          </h1>
          <p style={{ lineHeight: 1.5, marginBottom: '1.5rem' }}>
            Something went wrong while rendering this page. The scribes have
            been notified.
          </p>
          <button
            onClick={reset}
            style={{
              padding: '0.6rem 1.1rem',
              background: 'var(--ink-muted)',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: '0.95rem',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
