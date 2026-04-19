// Next.js configuration. Kept minimal — the custom server.ts owns bootstrap.

import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Externalise packages that hold module-level singleton state, so the
  // whole server process (custom server.ts + every route handler) shares
  // one canonical copy loaded from node_modules at runtime rather than a
  // bundled copy per route chunk. Two copies of `yjs` in particular
  // fires the "Yjs was already imported" warning and surfaces as
  // "SyntaxError: Unexpected token ','" under load.
  //
  // Deliberately NOT externalised: anything that imports React
  // (@tiptap/react, etc.). Externalising those makes them resolve
  // `react` outside the chunk Next primes with an SSR dispatcher,
  // so hook calls hit a null `ReactSharedInternals.H` and SSR
  // blows up with "null is not an object (evaluating
  // 'ReactSharedInternals.H.useRef')". @tiptap/* has no singleton
  // state; bundling it is safe and keeps its React imports on the
  // same copy Next is using.
  //
  // `bun:sqlite` is a Bun runtime built-in with no Node equivalent.
  // Next's build phase runs under Node, so keep the import external
  // so webpack doesn't try to resolve it at analysis time.
  serverExternalPackages: [
    'bun:sqlite',
    'yjs',
    'y-prosemirror',
    'y-protocols',
    'lib0',
    '@hocuspocus/server',
    '@hocuspocus/provider',
    '@hocuspocus/extension-database',
    '@hocuspocus/extension-logger',
    'prosemirror-model',
    'prosemirror-state',
    'prosemirror-view',
    'prosemirror-transform',
    'prosemirror-commands',
    'prosemirror-history',
    'prosemirror-keymap',
    'prosemirror-schema-list',
  ],
  webpack: (cfg) => {
    cfg.externals = cfg.externals ?? [];
    cfg.externals.push({ 'bun:sqlite': 'commonjs bun:sqlite' });
    return cfg;
  },
};

export default config;
