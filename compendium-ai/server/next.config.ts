// Next.js configuration. Kept minimal — the custom server.ts owns bootstrap.

import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // `bun:sqlite` is a Bun runtime built-in with no Node equivalent. Next's
  // build phase runs in Node, so we keep the import external (don't bundle,
  // don't try to resolve at analysis time) and let Bun resolve it at runtime.
  serverExternalPackages: ['bun:sqlite'],
  webpack: (cfg) => {
    cfg.externals = cfg.externals ?? [];
    cfg.externals.push({ 'bun:sqlite': 'commonjs bun:sqlite' });
    return cfg;
  },
};

export default config;
