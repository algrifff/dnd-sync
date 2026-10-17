'use client';

// GraphCanvas3D imports three at module scope, which touches WebGL globals.
// ssr:false keeps it out of the server render. Same pattern as
// ../graph/GraphCanvasLoader.tsx.

import nextDynamic from 'next/dynamic';

export const GraphCanvas3D = nextDynamic(
  () => import('../../../graph/GraphCanvas3D').then((m) => m.GraphCanvas3D),
  { ssr: false },
);
