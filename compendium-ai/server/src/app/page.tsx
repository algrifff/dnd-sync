// Admin dashboard. Polls /api/stats every 2s. Token is stored in
// localStorage — there is no cookie/session layer by design, the
// dashboard is purely for the vault owner.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type DocStats = { path: string; connections: number };
type RecentDoc = { path: string; updatedAt: number; bytes: number };

type Stats = {
  uptimeSeconds: number;
  schemaVersion: number;
  commit: string | null;
  dbSizeBytes: number;
  textDocs: { count: number; totalBytes: number };
  binaryFiles: { count: number; totalBytes: number };
  connections: { total: number; byDoc: DocStats[] };
  recentDocs: RecentDoc[];
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

      {stats && <StatsView stats={stats} />}
      {token && <InstallersSection token={token} />}

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

function InstallersSection({ token }: { token: string }) {
  const [installerKey, setInstallerKey] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string>('');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const loadKey = useCallback(async () => {
    const res = await fetch('/api/installer', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return;
    const body = (await res.json()) as { installerKey: string };
    setInstallerKey(body.installerKey);
  }, [token]);

  useEffect(() => {
    void loadKey();
  }, [loadKey]);

  const rotate = useCallback(async () => {
    if (!confirm('Rotate the installer key? Old URLs will stop working.')) return;
    const res = await fetch('/api/installer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { installerKey: string };
    setInstallerKey(body.installerKey);
  }, [token]);

  const copy = useCallback((label: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setJustCopied(label);
      setTimeout(() => setJustCopied(null), 1500);
    });
  }, []);

  if (!installerKey || !origin) return null;

  const macCmd = `curl -fsSL "${origin}/install/mac?key=${installerKey}" | bash`;
  const linuxCmd = `curl -fsSL "${origin}/install/linux?key=${installerKey}" | bash`;
  const windowsUrl = `${origin}/install/windows.bat?key=${installerKey}`;

  const rows = [
    {
      label: 'Mac',
      hint: 'Paste into Terminal (Cmd+Space → "Terminal"). Bypasses Gatekeeper.',
      value: macCmd,
    },
    {
      label: 'Linux',
      hint: 'Paste into any terminal.',
      value: linuxCmd,
    },
    {
      label: 'Windows',
      hint: 'Open this URL in a browser — it downloads compendium-windows.bat. Double-click to run.',
      value: windowsUrl,
    },
  ];

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-neutral-300">Friend installers</h2>
        <button
          onClick={rotate}
          className="text-xs text-neutral-400 hover:text-amber-400"
          title="Invalidate current commands + URL"
        >
          rotate key
        </button>
      </div>
      <p className="text-xs text-neutral-500 mb-3">
        Share the right command per friend. Rotate the key if any leaks.
      </p>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.label}>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-500 w-16 shrink-0">{r.label}</span>
              <code className="flex-1 font-mono text-xs text-neutral-300 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 truncate">
                {r.value}
              </code>
              <button
                onClick={() => copy(r.label, r.value)}
                className="text-xs px-2 py-1 rounded border border-neutral-700 hover:border-amber-500 hover:text-amber-400 shrink-0"
              >
                {justCopied === r.label ? 'copied' : 'copy'}
              </button>
            </div>
            <div className="text-xs text-neutral-500 mt-1 ml-[4.5rem]">{r.hint}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatsView({ stats }: { stats: Stats }) {
  const tiles = useMemo(
    () => [
      { label: 'Uptime', value: fmtUptime(stats.uptimeSeconds) },
      { label: 'Connections', value: String(stats.connections.total), emphasis: stats.connections.total > 0 },
      { label: 'Text docs', value: String(stats.textDocs.count), hint: fmtBytes(stats.textDocs.totalBytes) },
      { label: 'Binary files', value: String(stats.binaryFiles.count), hint: fmtBytes(stats.binaryFiles.totalBytes) },
      { label: 'DB size', value: fmtBytes(stats.dbSizeBytes) },
      { label: 'Schema', value: `v${stats.schemaVersion}`, hint: stats.commit ? stats.commit.slice(0, 7) : undefined },
    ],
    [stats],
  );

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">{t.label}</div>
            <div className={`mt-1 text-xl font-semibold ${t.emphasis ? 'text-amber-400' : ''}`}>
              {t.value}
            </div>
            {t.hint && <div className="text-xs text-neutral-500 mt-0.5">{t.hint}</div>}
          </div>
        ))}
      </section>

      <section className="grid md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h2 className="text-sm font-semibold text-neutral-300 mb-3">Active docs</h2>
          {stats.connections.byDoc.length === 0 ? (
            <div className="text-sm text-neutral-500">No clients connected.</div>
          ) : (
            <ul className="space-y-1">
              {stats.connections.byDoc.map((d) => (
                <li key={d.path} className="flex justify-between text-sm font-mono">
                  <span className="truncate mr-3">{d.path}</span>
                  <span className="text-amber-400">{d.connections}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h2 className="text-sm font-semibold text-neutral-300 mb-3">Recently updated</h2>
          {stats.recentDocs.length === 0 ? (
            <div className="text-sm text-neutral-500">No docs yet.</div>
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
        </div>
      </section>
    </div>
  );
}
