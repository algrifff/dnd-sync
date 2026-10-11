'use client';

import { useState } from 'react';
import { EVENTS, track } from '@/lib/analytics/client';

type Phase = 'idle' | 'confirming' | 'working' | 'sent' | 'error';

export function EndSessionButton({
  sessionPath,
  csrfToken,
  campaignSlug,
}: {
  sessionPath: string;
  csrfToken: string;
  campaignSlug: string | undefined;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleConfirm() {
    track(EVENTS.END_SESSION_CONFIRMED, {
      session_path: sessionPath,
      campaign_slug: campaignSlug ?? null,
    });
    setPhase('working');
    try {
      const res = await fetch('/api/sessions/mark-closed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ sessionPath }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      track(EVENTS.END_SESSION_FAILED, {
        session_path: sessionPath,
        reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      });
      setErrorMsg(err instanceof Error ? err.message : 'Failed to close session.');
      setPhase('error');
      return;
    }

    setPhase('sent');
  }

  function handleCancel() {
    setPhase('idle');
  }

  // ── Sent ─────────────────────────────────────────────────────────────
  if (phase === 'sent') {
    return (
      <div className="mb-5 rounded-[6px] border border-[var(--wine)]/30 bg-[var(--wine)]/8 px-4 py-3">
        <p className="text-sm text-[var(--ink)]">Session closed.</p>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <div className="mb-5 rounded-[6px] border border-[var(--wine)]/40 bg-[var(--wine)]/10 px-4 py-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--wine)]">Error</p>
        <p className="mb-2 text-sm text-[var(--ink)]">{errorMsg}</p>
        <button
          onClick={() => setPhase('idle')}
          className="text-xs text-[var(--wine)] underline underline-offset-2 hover:opacity-70"
        >
          Try again
        </button>
      </div>
    );
  }

  // ── Working (marking closed) ──────────────────────────────────────────
  if (phase === 'working') {
    return (
      <div className="mb-5 flex items-center gap-2.5 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment-sunk)]/50 px-4 py-3">
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--wine)] border-t-transparent" />
        <span className="text-sm text-[var(--ink-soft)]">Closing session…</span>
      </div>
    );
  }

  // ── Confirming ────────────────────────────────────────────────────────
  if (phase === 'confirming') {
    return (
      <div className="mb-5 rounded-[6px] border border-[var(--wine)]/40 bg-[var(--wine)]/8 px-4 py-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--wine)]">
          End of session
        </p>
        <p className="mb-3 text-sm text-[var(--ink)]">
          Mark this session as closed.
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void handleConfirm()}
            className="rounded-[4px] bg-[var(--wine)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] hover:bg-[#7a3f47] active:opacity-80"
          >
            End session
          </button>
          <button
            onClick={handleCancel}
            className="text-xs text-[var(--ink-soft)] underline underline-offset-2 hover:opacity-70"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Idle ──────────────────────────────────────────────────────────────
  return (
    <button
      onClick={() => {
        track(EVENTS.END_SESSION_CLICKED, {
          session_path: sessionPath,
          campaign_slug: campaignSlug ?? null,
        });
        setPhase('confirming');
      }}
      className="mb-5 rounded-[4px] bg-[var(--wine)] px-4 py-2 text-sm font-medium text-[var(--parchment)] transition-opacity hover:opacity-85 active:opacity-70"
    >
      End of Session
    </button>
  );
}
