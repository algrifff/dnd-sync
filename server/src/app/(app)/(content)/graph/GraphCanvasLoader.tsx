'use client';

// Thin client-side wrapper around next/dynamic for GraphCanvas.
//
// `ssr: false` cannot be passed to next/dynamic from inside a Server
// Component (Next 15 rejects the build outright — "ssr: false is not
// allowed with next/dynamic in Server Components. Please move it into
// a Client Component."). This file is that Client Component boundary;
// ../page.tsx (a Server Component) imports GraphCanvas from here
// instead of calling next/dynamic itself.
//
// Why ssr:false matters here specifically: GraphCanvas transitively
// imports sigma + graphology + graphology-layout-forceatlas2 at module
// scope. next.config.ts already lists all three in
// serverExternalPackages so they aren't bundled into the server chunk,
// but externalising only changes *how* they're loaded (native require
// vs. webpack bundle) — it does not stop the server from loading them
// at all. Without ssr:false, Next still server-renders this 'use
// client' component on first request, which evaluates those
// module-scope imports on the server. sigma touches
// WebGL2RenderingContext-adjacent browser globals; there's no
// guarantee that stays inert under Node. ssr:false skips that
// evaluation entirely — the module is only ever imported in the
// browser, which is what the next.config.ts comment ("RSC never tries
// to evaluate its GL-touching code") already assumed was happening.
//
// Bundle-size note: contrary to the initial assumption that this would
// only matter for SSR (GraphCanvas renders unconditionally with nothing
// else on the page, so the browser still has to fetch its chunk right
// after mount either way), it also measurably shrinks /graph's reported
// First Load JS: 259 kB (static import) -> 166 kB (this dynamic,
// ssr:false import), per `next build`'s route table. Next excludes a
// ssr:false dynamic chunk from "First Load JS" because it's fetched via
// the client-side lazy-loading path rather than required for the
// server-rendered/hydration bundle — even though the browser ends up
// requesting it moments later, it's not on the critical hydration path.
// /graph-3d (GraphCanvas3D, untouched by this change) was ~342 kB own +
// 601 kB First Load JS before and ~354 kB + 601 kB after — essentially
// unchanged, as expected for a route this file doesn't touch.

import nextDynamic from 'next/dynamic';

export const GraphCanvas = nextDynamic(
  () => import('../../../graph/GraphCanvas').then((m) => m.GraphCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 flex items-center justify-center bg-[var(--parchment)] text-sm text-[var(--ink-soft)]">
        Loading graph…
      </div>
    ),
  },
);
