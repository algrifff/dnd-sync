'use client';

// Client Component boundary for next/dynamic with ssr:false, the same
// reason GraphCanvasLoader.tsx (classic/) exists: Next 15 rejects
// `ssr: false` in a Server Component. The Orrery draws to a canvas and
// reads computed styles on mount, so it never renders on the server.

import nextDynamic from 'next/dynamic';

export const OrreryCanvas = nextDynamic(
  () => import('../../../graph/orrery/OrreryCanvas').then((m) => m.OrreryCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 flex items-center justify-center bg-[var(--parchment)] text-sm text-[var(--ink-soft)]">
        Loading graph…
      </div>
    ),
  },
);
