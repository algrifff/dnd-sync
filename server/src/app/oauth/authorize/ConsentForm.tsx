'use client';

// World picker + approve/deny. Posts the decision as JSON (with the CSRF
// header, like every other settings form) and then navigates to the
// redirect the server hands back. Navigating from script rather than
// submitting a form keeps the app-wide `form-action 'self'` CSP intact.

import { useState } from 'react';

type World = { id: string; name: string; role: 'admin' | 'editor' | 'viewer'; isActive: boolean };

export function ConsentForm({
  csrfToken,
  query,
  clientName,
  redirectHost,
  verified,
  worlds,
  invalid,
}: {
  csrfToken: string;
  query: Record<string, string>;
  clientName: string;
  redirectHost: string;
  verified: boolean;
  worlds: World[];
  invalid: string | null;
}): React.JSX.Element {
  const [groupId, setGroupId] = useState<string>(
    worlds.find((w) => w.isActive)?.id ?? worlds[0]?.id ?? '',
  );
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ decision, group_id: groupId, query }),
      });
      const body = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string; reason?: string };
      if (!res.ok || !body.redirect) {
        setError(body.reason ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      window.location.assign(body.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  if (invalid) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-[var(--wine)]">{invalid}</p>
        <button type="button" onClick={() => decide('deny')} disabled={pending} className={secondaryButton}>
          Return to {redirectHost}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {!verified && (
        <p
          role="alert"
          className="rounded-[8px] border border-[var(--wine)] px-3 py-2 text-sm text-[var(--wine)]"
        >
          <span className="font-medium">Unverified app.</span> Anyone can name an app “{clientName}”.
          This one will send you to {redirectHost}. Only continue if you started this connection yourself
          and recognise that address.
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-[var(--ink-soft)]">World to share</legend>
        {worlds.length === 0 && (
          <p className="text-sm text-[var(--wine)]">You are not a member of any world yet.</p>
        )}
        {worlds.map((w) => (
          <label
            key={w.id}
            className="flex cursor-pointer items-center gap-3 rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)] px-3 py-2 text-sm text-[var(--ink)] has-[:checked]:border-[var(--candlelight)]"
          >
            <input
              type="radio"
              name="world"
              value={w.id}
              checked={groupId === w.id}
              onChange={() => setGroupId(w.id)}
              className="accent-[var(--candlelight)]"
            />
            <span className="flex-1">{w.name}</span>
            <span className="text-xs text-[var(--ink-muted)]">{w.role}</span>
          </label>
        ))}
      </fieldset>

      <p className="text-xs text-[var(--ink-muted)]">
        After you approve, you will be sent to <span className="font-medium text-[var(--ink-soft)]">{redirectHost}</span>.
        You can disconnect {clientName} at any time from Settings → Profile → Connected apps.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => decide('approve')}
          disabled={pending || !groupId}
          className="rounded-[8px] bg-[var(--ink)] px-4 py-2 text-sm font-medium text-[var(--parchment)] transition hover:scale-[1.015] hover:bg-[var(--vellum)] disabled:opacity-50 disabled:hover:scale-100"
        >
          {pending ? 'Working…' : 'Allow read access'}
        </button>
        <button type="button" onClick={() => decide('deny')} disabled={pending} className={secondaryButton}>
          Cancel
        </button>
        {error && <span className="text-sm text-[var(--wine)]">{error}</span>}
      </div>
    </div>
  );
}

const secondaryButton =
  'rounded-[8px] border border-[var(--rule)] px-4 py-2 text-sm text-[var(--ink-soft)] transition hover:border-[var(--ink-soft)] hover:text-[var(--ink)] disabled:opacity-50';
