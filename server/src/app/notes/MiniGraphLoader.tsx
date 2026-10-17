'use client';

// MiniGraph imports sigma + graphology at module scope, which touch
// WebGL2RenderingContext. Without ssr:false, the note page's server render
// evaluates them and throws "WebGL2RenderingContext is not defined". Same
// pattern as app/(app)/(content)/graph/GraphCanvasLoader.tsx.

import nextDynamic from 'next/dynamic';

export const MiniGraph = nextDynamic(() => import('./MiniGraph').then((m) => m.MiniGraph), {
  ssr: false,
});
