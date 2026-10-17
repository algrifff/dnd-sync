'use client';

// MiniGraph draws to a <canvas> and reads computed styles on mount, so it
// is loaded client-only. `ssr: false` cannot be passed to next/dynamic from
// a Server Component (NoteSidebar), hence this wrapper. Same pattern as
// app/(app)/(content)/graph/OrreryLoader.tsx.

import nextDynamic from 'next/dynamic';

export const MiniGraph = nextDynamic(() => import('./MiniGraph').then((m) => m.MiniGraph), {
  ssr: false,
  loading: () => <div className="h-[260px] w-[260px] rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)]" aria-hidden />,
});
