// Legacy bearer-token admin dashboard. Polls /api/stats every 2s.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Stats = {
  uptimeSeconds: number;
  schemaVersion: number;
  commit: string | null;
  dbSizeBytes: number;
  notes: { count: number };
  assets: { count: number; totalBytes: number };
  recentDocs: Array<{ path: string; updatedAt: number }>;
};

const TOKEN_KEY = 'compendium.adminToken';
const POLL_MS = 2000;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtAgo(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

export default function Dashboard() {
  const [token, setToken] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
  }, []);

  const fetchStats = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/stats', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) {
        setError('Admin token rejected.');
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        return;
      }
      if (!res.ok) {
        setError(`stats failed: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as Stats;
      setStats(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetchStats();
    const id = setInterval(fetchStats, POLL_MS);
    return () => clearInterval(id);
  }, [token, fetchStats]);

  if (!token) return <LoginForm onSubmit={(t) => { localStorage.setItem(TOKEN_KEY, t); setToken(t); }} />;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <header className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Compendium</h1>
        <div className="text-xs text-neutral-500">
          {stats ? `updated ${fmtAgo(Date.now())}` : 'connecting…'}
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <Tabs
        tabs={[
          {
            id: 'overview',
            label: 'Overview',
            render: () => stats ? <StatsTiles stats={stats} /> : null,
          },
          {
            id: 'docs',
            label: 'Docs',
            render: () => stats ? <DocsView stats={stats} /> : null,
          },
        ]}
      />

      <footer className="mt-10 flex items-center gap-3 text-xs text-neutral-500">
        <button
          onClick={() => { localStorage.removeItem(TOKEN_KEY); setToken(null); }}
          className="underline-offset-2 hover:underline"
        >
          sign out
        </button>
        <span>·</span>
        <span>polling every {POLL_MS / 1000}s</span>
      </footer>
    </main>
  );
}

function Tabs({
  tabs,
}: {
  tabs: Array<{ id: string; label: string; render: () => React.ReactNode }>;
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <div>
      <div className="flex border-b border-neutral-800 mb-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={
              'px-4 py-2 text-sm border-b-2 -mb-px transition ' +
              (active === t.id
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-neutral-400 hover:text-neutral-200')
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>{current?.render()}</div>
    </div>
  );
}

function LoginForm({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
      <form
        className="w-full max-w-sm space-y-4 p-6 rounded-lg border border-neutral-800 bg-neutral-900"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <div>
          <h1 className="text-xl font-semibold">Compendium</h1>
          <p className="text-sm text-neutral-400 mt-1">Admin dashboard</p>
        </div>
        <label className="block text-sm">
          <span className="text-neutral-300">Admin token</span>
          <input
            autoFocus
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md bg-neutral-950 border border-neutral-700 px-3 py-2 font-mono text-sm outline-none focus:border-neutral-500"
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-md bg-amber-500 text-neutral-950 py-2 font-medium hover:bg-amber-400 transition"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}

function StatsTiles({ stats }: { stats: Stats }) {
  const tiles = useMemo(
    () => [
      { label: 'Uptime', value: fmtUptime(stats.uptimeSeconds), hint: undefined },
      { label: 'Notes', value: String(stats.notes.count), hint: undefined },
      { label: 'Assets', value: String(stats.assets.count), hint: fmtBytes(stats.assets.totalBytes) },
      { label: 'DB size', value: fmtBytes(stats.dbSizeBytes), hint: undefined },
      { label: 'Schema', value: `v${stats.schemaVersion}`, hint: stats.commit ? stats.commit.slice(0, 7) : undefined },
    ],
    [stats],
  );

  return (
    <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-neutral-500">{t.label}</div>
          <div className="mt-1 text-xl font-semibold">
            {t.value}
          </div>
          {t.hint && <div className="text-xs text-neutral-500 mt-0.5">{t.hint}</div>}
        </div>
      ))}
    </section>
  );
}

function DocsView({ stats }: { stats: Stats }) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h2 className="text-sm font-semibold text-neutral-300 mb-3">Recently updated</h2>
      {stats.recentDocs.length === 0 ? (
        <div className="text-sm text-neutral-500">No notes yet.</div>
      ) : (
        <ul className="space-y-1">
          {stats.recentDocs.map((d) => (
            <li key={d.path} className="flex justify-between text-sm font-mono">
              <span className="truncate mr-3">{d.path}</span>
              <span className="text-neutral-500">{fmtAgo(d.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
