'use client';

// The apps (Claude, mostly) this user has let read a world through the
// MCP connector. Disconnecting deletes the grant, which cascades every
// token, so the app has to go through consent again.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type ConnectedApp = {
  id: string;
  clientName: string;
  worldName: string;
  createdAt: number;
  lastUsedAt: number;
};

export function ConnectedApps({
  apps,
  csrfToken,
}: {
  apps: ConnectedApp[];
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async (id: string): Promise<void> => {
    setPendingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/oauth/grants/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPendingId(null);
    }
  };

  if (apps.length === 0) {
    return <p className="text-sm text-[var(--ink-muted)]">Nothing is connected.</p>;
  }

  return (
    <ul className="divide-y divide-[var(--rule)]">
      {apps.map((app) => (
        <li key={app.id} className="flex items-center gap-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--ink)]">
              {app.clientName} <span className="text-[var(--ink-muted)]">reads</span> {app.worldName}
            </div>
            <div className="text-xs text-[var(--ink-muted)]">
              Connected {formatDate(app.createdAt)}, last used {formatDate(app.lastUsedAt)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => disconnect(app.id)}
            disabled={pendingId !== null}
            className="rounded-[8px] border border-[var(--rule)] px-3 py-1.5 text-sm text-[var(--ink-soft)] transition hover:border-[var(--wine)] hover:text-[var(--wine)] disabled:opacity-50"
          >
            {pendingId === app.id ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </li>
      ))}
      {error && (
        <li className="py-2 text-sm text-[var(--wine)]">{error}</li>
      )}
    </ul>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
