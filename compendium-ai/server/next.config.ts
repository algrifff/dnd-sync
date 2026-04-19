// Next.js configuration. Kept minimal — the custom server.ts owns bootstrap.

import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Externalise packages whose modules have top-level side effects
  // (registrations against a shared registry, singleton construction)
  // so the whole server process — custom server.ts + every route
  // handler — shares one copy loaded from node_modules rather than a
  // bundled copy per route chunk.
  //
  // What needs externalising:
  //   * yjs + its ecosystem — Yjs keeps a module-level constructor
  //     registry; two copies trips "Yjs was already imported".
  //   * hocuspocus — wraps yjs, same concern.
  //   * prosemirror-* (every one we pull in) — prosemirror-gapcursor,
  //     prosemirror-dropcursor etc. call Selection.jsonID at module
  //     scope; double-loading throws
  //     "RangeError: Duplicate use of selection JSON ID".
  //   * @tiptap/* EXCEPT @tiptap/react — tiptap-core and the non-React
  //     extensions transitively load prosemirror-* and apply their
  //     own side effects; keep them on the single node_modules copy
  //     so those effects fire once.
  //
  // What must NOT be externalised:
  //   * @tiptap/react — externalising it makes its `import React from
  //     "react"` resolve outside the chunk Next primes with an SSR
  //     dispatcher, so hook calls inside useEditor hit a null
  //     ReactSharedInternals.H. Bundle it so its React import stays
  //     on the copy Next is serving.
  //
  // `bun:sqlite` is a Bun runtime built-in with no Node equivalent.
  // Keeping it external stops webpack from trying to resolve it at
  // analysis time under Node.
  serverExternalPackages: [
    'bun:sqlite',

    // Yjs ecosystem.
    'yjs',
    'y-prosemirror',
    'y-protocols',
    'lib0',

    // Hocuspocus (wraps Yjs).
    '@hocuspocus/server',
    '@hocuspocus/provider',
    '@hocuspocus/extension-database',
    '@hocuspocus/extension-logger',

    // ProseMirror — every package we pull in, including the ones
    // StarterKit brings in transitively.
    'prosemirror-changeset',
    'prosemirror-commands',
    'prosemirror-dropcursor',
    'prosemirror-gapcursor',
    'prosemirror-history',
    'prosemirror-inputrules',
    'prosemirror-keymap',
    'prosemirror-markdown',
    'prosemirror-model',
    'prosemirror-schema-basic',
    'prosemirror-schema-list',
    'prosemirror-state',
    'prosemirror-tables',
    'prosemirror-transform',
    'prosemirror-view',

    // Tiptap, excluding @tiptap/react (React-aware, must stay
    // bundled so hooks share Next's React copy).
    '@tiptap/core',
    '@tiptap/starter-kit',
    '@tiptap/extension-collaboration',
    '@tiptap/extension-collaboration-caret',
    '@tiptap/extension-highlight',
    '@tiptap/extension-image',
    '@tiptap/extension-link',
    '@tiptap/extension-table',
    '@tiptap/extension-table-cell',
    '@tiptap/extension-table-header',
    '@tiptap/extension-table-row',
    '@tiptap/extension-task-item',
    '@tiptap/extension-task-list',

    // Graph rendering — browser-only (touches WebGL2RenderingContext
    // at module scope). Externalising keeps it out of the server
    // bundle so RSC never tries to evaluate its GL-touching code
    // when rendering the graph/note pages. The client island
    // (GraphCanvas / MiniGraph) imports them normally from
    // node_modules at runtime in the browser.
    'sigma',
    'graphology',
    'graphology-layout-forceatlas2',
  ],
  webpack: (cfg) => {
    cfg.externals = cfg.externals ?? [];
    cfg.externals.push({ 'bun:sqlite': 'commonjs bun:sqlite' });
    return cfg;
  },
};

export default config;
