// Next.js configuration. Kept minimal — the custom server.ts owns bootstrap.

import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Any package that pulls in `yjs` (directly or transitively) must be
  // marked external for server-side bundling. `yjs` keeps a module-
  // level registry; if the custom server loads one copy from
  // node_modules and a bundled route handler loads another,
  // constructor checks fail with "Yjs was already imported" and
  // downstream JSON.parse calls surface as the opaque
  // "SyntaxError: Unexpected token ','". Externalising forces the
  // whole server process — server.ts + every route handler — to
  // resolve to the single copy in node_modules.
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
    '@tiptap/core',
    '@tiptap/starter-kit',
    '@tiptap/react',
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
