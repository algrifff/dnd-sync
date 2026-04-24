'use client';

import { useState } from 'react';
import { EVENTS, track } from '@/lib/analytics/client';

type Phase = 'idle' | 'confirming' | 'working' | 'sent' | 'error';

export function EndSessionButton({
  sessionPath,
  csrfToken,
  isAlreadyClosed,
  campaignSlug,
}: {
  sessionPath: string;
  csrfToken: string;
  isAlreadyClosed: boolean;
  campaignSlug: string | undefined;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleConfirm() {
    track(EVENTS.END_SESSION_CONFIRMED, {
      session_path: sessionPath,
      campaign_slug: campaignSlug ?? null,
      was_already_closed: isAlreadyClosed,
    });
    setPhase('working');
    try {
      // Mark the session closed in the DB first
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

    // Short trigger message — the session.md skill contains the full
    // extraction instructions; the AI will call note_read to fetch content.
    const campaignLine = campaignSlug ? ` (campaign: ${campaignSlug})` : '';
    const message = `End of session: "${sessionPath}"${campaignLine}. Please read the session note and update the compendium.`;

    // Hand off to the chat pane — it will auto-send the message and show streaming progress
    window.dispatchEvent(
      new CustomEvent('compendium:open-chat', {
        detail: { message, autoSend: true },
      }),
    );

    setPhase('sent');
  }

  function handleCancel() {
    setPhase('idle');
  }

  // ── Sent ─────────────────────────────────────────────────────────────
  if (phase === 'sent') {
    return (
      <div className="mb-5 rounded-[6px] border border-[var(--wine)]/30 bg-[var(--wine)]/8 px-4 py-3">
        <p className="text-sm text-[var(--ink)]">
          Session closed — the AI is processing your notes in the chat panel.
        </p>
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
        {isAlreadyClosed ? (
          <>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--wine)]">
              Already closed
            </p>
            <p className="mb-3 text-sm text-[var(--ink)]">
              This session has already been ended. Running again may add duplicate
              information to your entity notes. Are you sure?
            </p>
          </>
        ) : (
          <>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--wine)]">
              End of session
            </p>
            <p className="mb-3 text-sm text-[var(--ink)]">
              The AI will read your session notes, create or update entity pages for every
              NPC, location, and creature it finds, and add wikilinks back to this session.
              Progress will stream in the chat panel.
            </p>
          </>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={() => void handleConfirm()}
            className="rounded-[4px] bg-[var(--wine)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] hover:bg-[#7a3f47] active:opacity-80"
          >
            {isAlreadyClosed ? 'Run anyway' : 'End session'}
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
          was_already_closed: isAlreadyClosed,
        });
        setPhase('confirming');
      }}
      className="mb-5 rounded-[4px] bg-[var(--wine)] px-4 py-2 text-sm font-medium text-[var(--parchment)] transition-opacity hover:opacity-85 active:opacity-70"
    >
      End of Session
    </button>
  );
}
