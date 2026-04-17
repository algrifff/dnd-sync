// Live-connection stats the dashboard polls. The probe is stashed on
// globalThis because Next.js route handlers and server.ts are compiled in
// separate webpack bundles — module-level bindings don't cross that
// boundary, but globalThis does (same Node process).

type DocStats = {
  path: string;
  connections: number;
};

type StatsProbe = () => DocStats[];

declare global {
  // eslint-disable-next-line no-var
  var __compendiumStatsProbe: StatsProbe | undefined;
}

/** Called once from ws/setup.ts after the docs map is constructed. */
export function registerStatsProbe(fn: StatsProbe): void {
  globalThis.__compendiumStatsProbe = fn;
}

export function getLiveStats(): { totalConnections: number; byDoc: DocStats[] } {
  const byDoc = globalThis.__compendiumStatsProbe?.() ?? [];
  return {
    totalConnections: byDoc.reduce((n, d) => n + d.connections, 0),
    byDoc,
  };
}
