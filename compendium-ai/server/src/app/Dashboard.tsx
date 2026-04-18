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

      <Tabs
        tabs={[
          {
            id: 'overview',
            label: 'Overview',
            render: () => (
              <>
                {stats && <StatsTiles stats={stats} />}
                <InstallersSection token={token} />
              </>
            ),
          },
          {
            id: 'docs',
            label: 'Docs',
            render: () => (stats ? <DocsView stats={stats} /> : null),
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

type Credentials = {
  serverUrl: string;
  installerKey: string;
  shared: { playerToken: string };
  friends: Array<{
    id: string;
    name: string;
    token: string;
    createdAt: number;
    lastSeenAt: number | null;
  }>;
};

function lastSeenBadge(lastSeenAt: number | null): { text: string; tone: 'green' | 'yellow' | 'grey' } {
  if (lastSeenAt === null) return { text: 'never connected', tone: 'grey' };
  const delta = Date.now() - lastSeenAt;
  if (delta < 5 * 60_000) return { text: `seen ${fmtAgo(lastSeenAt)}`, tone: 'green' };
  if (delta < 24 * 3_600_000) return { text: `seen ${fmtAgo(lastSeenAt)}`, tone: 'yellow' };
  return { text: `seen ${fmtAgo(lastSeenAt)}`, tone: 'grey' };
}

function InstallersSection({ token }: { token: string }) {
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [newFriendName, setNewFriendName] = useState('');
  const [expandedFriend, setExpandedFriend] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState<string | null>(null);

  const loadCreds = useCallback(async () => {
    const res = await fetch('/api/credentials', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return;
    setCreds((await res.json()) as Credentials);
  }, [token]);

  useEffect(() => { void loadCreds(); }, [loadCreds]);

  const copy = useCallback((label: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setJustCopied(label);
      setTimeout(() => setJustCopied(null), 1500);
    });
  }, []);

  const rotateKey = useCallback(async () => {
    if (!confirm('Rotate the installer key? All current install URLs will stop working.')) return;
    const res = await fetch('/api/installer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    await loadCreds();
  }, [token, loadCreds]);

  const addFriend = useCallback(async () => {
    const name = newFriendName.trim();
    if (!name) return;
    const res = await fetch('/api/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    setNewFriendName('');
    await loadCreds();
  }, [newFriendName, token, loadCreds]);

  const revokeFriend = useCallback(
    async (id: string) => {
      if (!confirm("Revoke this friend? They'll be disconnected immediately.")) return;
      const res = await fetch(`/api/friends/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      if (expandedFriend === id) setExpandedFriend(null);
      await loadCreds();
    },
    [token, expandedFriend, loadCreds],
  );

  if (!creds) return null;

  return (
    <div className="mt-6 space-y-4">
      <SharedInstallerPanel
        creds={creds}
        onRotate={rotateKey}
        copy={copy}
        justCopied={justCopied}
      />
      <FriendsPanel
        creds={creds}
        newName={newFriendName}
        onNewNameChange={setNewFriendName}
        onAdd={addFriend}
        onRevoke={revokeFriend}
        expandedId={expandedFriend}
        onToggleExpanded={setExpandedFriend}
        copy={copy}
        justCopied={justCopied}
      />
    </div>
  );
}

type CopyFn = (label: string, value: string) => void;

function installCommandFor(
  kind: 'mac' | 'linux' | 'windows',
  creds: Credentials,
  friendId?: string,
): string {
  const params = new URLSearchParams({ key: creds.installerKey });
  if (friendId) params.set('friend', friendId);
  const url = `${creds.serverUrl}${kind === 'windows' ? '/install/windows.bat' : `/install/${kind}`}?${params.toString()}`;
  if (kind === 'windows') return url;
  return `curl -fsSL "${url}" | bash`;
}

function SharedInstallerPanel({
  creds,
  onRotate,
  copy,
  justCopied,
}: {
  creds: Credentials;
  onRotate: () => void;
  copy: CopyFn;
  justCopied: string | null;
}) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <header className="flex items-baseline justify-between mb-1">
        <h2 className="text-sm font-semibold text-neutral-300">Shared installers</h2>
        <button
          onClick={onRotate}
          className="text-xs text-neutral-400 hover:text-amber-400"
          title="Invalidate every current install URL"
        >
          rotate key
        </button>
      </header>
      <p className="text-xs text-neutral-500 mb-3">
        Quick tests. Any friend can run these — they all get the same shared token.
      </p>
      <InstallCommands creds={creds} scope="shared" copy={copy} justCopied={justCopied} />
      <ManualSetupFields
        scope="shared"
        serverUrl={creds.serverUrl}
        playerToken={creds.shared.playerToken}
        copy={copy}
        justCopied={justCopied}
      />
    </section>
  );
}

function FriendsPanel({
  creds,
  newName,
  onNewNameChange,
  onAdd,
  onRevoke,
  expandedId,
  onToggleExpanded,
  copy,
  justCopied,
}: {
  creds: Credentials;
  newName: string;
  onNewNameChange: (v: string) => void;
  onAdd: () => void;
  onRevoke: (id: string) => void;
  expandedId: string | null;
  onToggleExpanded: (id: string | null) => void;
  copy: CopyFn;
  justCopied: string | null;
}) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h2 className="text-sm font-semibold text-neutral-300 mb-1">Friends (per-person tokens)</h2>
      <p className="text-xs text-neutral-500 mb-3">
        Each friend has their own token — revoke one without affecting anyone else.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); onAdd(); }}
        className="flex gap-2 mb-4"
      >
        <input
          value={newName}
          onChange={(e) => onNewNameChange(e.target.value)}
          placeholder="Ben"
          className="flex-1 rounded-md bg-neutral-950 border border-neutral-700 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
        />
        <button
          type="submit"
          className="text-sm px-3 py-1.5 rounded-md bg-amber-500 text-neutral-950 font-medium hover:bg-amber-400 disabled:opacity-50"
          disabled={!newName.trim()}
        >
          Add friend
        </button>
      </form>

      {creds.friends.length === 0 ? (
        <div className="text-sm text-neutral-500">No friends yet.</div>
      ) : (
        <ul className="divide-y divide-neutral-800">
          {creds.friends.map((f) => {
            const isOpen = expandedId === f.id;
            return (
              <li key={f.id} className="py-2">
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-sm">{f.name}</span>
                  <FriendStatusBadge lastSeenAt={f.lastSeenAt} />
                  <button
                    onClick={() => onToggleExpanded(isOpen ? null : f.id)}
                    className="text-xs px-2 py-1 rounded border border-neutral-700 hover:border-amber-500 hover:text-amber-400"
                  >
                    {isOpen ? 'hide' : 'show install'}
                  </button>
                  <button
                    onClick={() => onRevoke(f.id)}
                    className="text-xs px-2 py-1 rounded border border-neutral-700 hover:border-red-500 hover:text-red-400"
                  >
                    revoke
                  </button>
                </div>
                {isOpen && (
                  <div className="mt-3 rounded border border-neutral-800 bg-neutral-950 p-3">
                    <InstallCommands
                      creds={creds}
                      scope={`friend-${f.id}`}
                      friendId={f.id}
                      copy={copy}
                      justCopied={justCopied}
                    />
                    <ManualSetupFields
                      scope={`friend-${f.id}`}
                      serverUrl={creds.serverUrl}
                      playerToken={f.token}
                      copy={copy}
                      justCopied={justCopied}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FriendStatusBadge({ lastSeenAt }: { lastSeenAt: number | null }) {
  const { text, tone } = lastSeenBadge(lastSeenAt);
  const colour =
    tone === 'green'
      ? 'text-emerald-400 border-emerald-900 bg-emerald-950/40'
      : tone === 'yellow'
        ? 'text-amber-400 border-amber-900 bg-amber-950/40'
        : 'text-neutral-500 border-neutral-800 bg-neutral-950/60';
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full border ${colour}`}
      title={lastSeenAt ? new Date(lastSeenAt).toLocaleString() : 'token not yet used'}
    >
      {text}
    </span>
  );
}

// ── Presentation components ─────────────────────────────────────────────────

function InstallCommands({
  creds,
  scope,
  friendId,
  copy,
  justCopied,
}: {
  creds: Credentials;
  scope: string;
  friendId?: string;
  copy: CopyFn;
  justCopied: string | null;
}) {
  const rows: Array<{ os: 'mac' | 'linux' | 'windows'; label: string; hint: string }> = [
    { os: 'mac', label: 'Mac', hint: 'Paste into Terminal.' },
    { os: 'linux', label: 'Linux', hint: 'Paste into any terminal.' },
    { os: 'windows', label: 'Windows', hint: 'Open in a browser → downloads .bat → double-click.' },
  ];
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const cmd = installCommandFor(r.os, creds, friendId);
        const id = `${scope}:${r.os}`;
        return (
          <li key={r.os}>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-500 w-16 shrink-0">{r.label}</span>
              <code className="flex-1 font-mono text-xs text-neutral-300 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 truncate">
                {cmd}
              </code>
              <button
                onClick={() => copy(id, cmd)}
                className="text-xs px-2 py-1 rounded border border-neutral-700 hover:border-amber-500 hover:text-amber-400 shrink-0"
              >
                {justCopied === id ? 'copied' : 'copy'}
              </button>
            </div>
            <div className="text-xs text-neutral-500 mt-1 ml-[4.5rem]">{r.hint}</div>
          </li>
        );
      })}
    </ul>
  );
}

function ManualSetupFields({
  scope,
  serverUrl,
  playerToken,
  copy,
  justCopied,
}: {
  scope: string;
  serverUrl: string;
  playerToken: string;
  copy: CopyFn;
  justCopied: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 pt-3 border-t border-neutral-800">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-neutral-400 hover:text-amber-400"
      >
        {open ? '▾' : '▸'} Manual setup (if the install script fails)
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-neutral-500">
            Paste these into Obsidian → Settings → Community plugins → Compendium.
          </p>
          <PlainField
            label="Server URL"
            value={serverUrl}
            copyId={`${scope}:url`}
            copy={copy}
            justCopied={justCopied}
          />
          <SecretField
            label="Auth token"
            value={playerToken}
            copyId={`${scope}:token`}
            copy={copy}
            justCopied={justCopied}
          />
        </div>
      )}
    </div>
  );
}

function PlainField({
  label,
  value,
  copyId,
  copy,
  justCopied,
}: {
  label: string;
  value: string;
  copyId: string;
  copy: CopyFn;
  justCopied: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-neutral-500 w-20 shrink-0">{label}</span>
      <code className="flex-1 font-mono text-xs text-neutral-300 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 truncate">
        {value}
      </code>
      <button
        onClick={() => copy(copyId, value)}
        className="text-xs px-2 py-1 rounded border border-neutral-700 hover:border-amber-500 hover:text-amber-400 shrink-0"
      >
        {justCopied === copyId ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

function SecretField({
  label,
  value,
  copyId,
  copy,
  justCopied,
}: {
  label: string;
  value: string;
  copyId: string;
  copy: CopyFn;
  justCopied: string | null;
}) {
  const [reveal, setReveal] = useState(false);
  const masked = '•'.repeat(Math.min(value.length, 24));
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-neutral-500 w-20 shrink-0">{label}</span>
      <code className="flex-1 font-mono text-xs text-neutral-300 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 truncate">
        {reveal ? value : masked}
      </code>
      <button
        onClick={() => setReveal(!reveal)}
        className="text-xs px-2 py-1 rounded border border-neutral-700 hover:border-amber-500 hover:text-amber-400 shrink-0"
      >
        {reveal ? 'hide' : 'reveal'}
      </button>
      <button
        onClick={() => copy(copyId, value)}
        className="text-xs px-2 py-1 rounded border border-neutral-700 hover:border-amber-500 hover:text-amber-400 shrink-0"
      >
        {justCopied === copyId ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

function StatsTiles({ stats }: { stats: Stats }) {
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
  );
}

function DocsView({ stats }: { stats: Stats }) {
  return (
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
  );
}
