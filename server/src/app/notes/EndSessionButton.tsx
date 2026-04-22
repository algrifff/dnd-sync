'use client';

import { useState } from 'react';

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
      <div className="mb-5 rounded-[6px] border border-[#8B4A52]/30 bg-[#8B4A52]/8 px-4 py-3">
        <p className="text-sm text-[#2A241E]">
          Session closed — the AI is processing your notes in the chat panel.
        </p>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <div className="mb-5 rounded-[6px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-4 py-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8B4A52]">Error</p>
        <p className="mb-2 text-sm text-[#2A241E]">{errorMsg}</p>
        <button
          onClick={() => setPhase('idle')}
          className="text-xs text-[#8B4A52] underline underline-offset-2 hover:opacity-70"
        >
          Try again
        </button>
      </div>
    );
  }

  // ── Working (marking closed) ──────────────────────────────────────────
  if (phase === 'working') {
    return (
      <div className="mb-5 flex items-center gap-2.5 rounded-[6px] border border-[#D4C7AE] bg-[#EAE1CF]/50 px-4 py-3">
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#8B4A52] border-t-transparent" />
        <span className="text-sm text-[#5A4F42]">Closing session…</span>
      </div>
    );
  }

  // ── Confirming ────────────────────────────────────────────────────────
  if (phase === 'confirming') {
    return (
      <div className="mb-5 rounded-[6px] border border-[#8B4A52]/40 bg-[#8B4A52]/8 px-4 py-3">
        {isAlreadyClosed ? (
          <>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8B4A52]">
              Already closed
            </p>
            <p className="mb-3 text-sm text-[#2A241E]">
              This session has already been ended. Running again may add duplicate
              information to your entity notes. Are you sure?
            </p>
          </>
        ) : (
          <>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8B4A52]">
              End of session
            </p>
            <p className="mb-3 text-sm text-[#2A241E]">
              The AI will read your session notes, create or update entity pages for every
              NPC, location, and creature it finds, and add wikilinks back to this session.
              Progress will stream in the chat panel.
            </p>
          </>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={() => void handleConfirm()}
            className="rounded-[4px] bg-[#8B4A52] px-3 py-1.5 text-xs font-medium text-[#F4EDE0] hover:bg-[#7a3f47] active:opacity-80"
          >
            {isAlreadyClosed ? 'Run anyway' : 'End session'}
          </button>
          <button
            onClick={handleCancel}
            className="text-xs text-[#5A4F42] underline underline-offset-2 hover:opacity-70"
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
      onClick={() => setPhase('confirming')}
      className="mb-5 rounded-[4px] bg-[#8B4A52] px-4 py-2 text-sm font-medium text-[#F4EDE0] transition-opacity hover:opacity-85 active:opacity-70"
    >
      End of Session
    </button>
  );
}
