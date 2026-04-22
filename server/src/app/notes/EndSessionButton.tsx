'use client';

import { useState } from 'react';

type Phase = 'idle' | 'confirming' | 'loading' | 'done' | 'error';

export function EndSessionButton({
  sessionPath,
  csrfToken,
  isAlreadyClosed,
}: {
  sessionPath: string;
  csrfToken: string;
  isAlreadyClosed: boolean;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [summary, setSummary] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  function handleClick() {
    setPhase('confirming');
  }

  function handleCancel() {
    setPhase('idle');
  }

  async function handleConfirm() {
    setPhase('loading');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      const res = await fetch('/api/sessions/end', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ sessionPath, force: isAlreadyClosed }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = (await res.json()) as Record<string, unknown>;
      if (data.ok) {
        const summaryText = typeof data.summary === 'string' ? data.summary : 'Session closed.';
        setSummary(summaryText);
        setPhase('done');
        window.dispatchEvent(
          new CustomEvent('compendium:open-chat', {
            detail: { prefill: 'The session has just been closed. What should we do next?' },
          }),
        );
      } else {
        setErrorMsg(typeof data.reason === 'string' ? data.reason : String(data.error ?? 'Something went wrong.'));
        setPhase('error');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Request failed.');
      setPhase('error');
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────
  if (phase === 'done') {
    return (
      <div className="mb-5 rounded-[6px] border border-[#8B4A52]/30 bg-[#8B4A52]/8 px-4 py-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8B4A52]">
          Session ended
        </p>
        <p className="text-sm text-[#2A241E]">{summary}</p>
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

  // ── Loading ───────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="mb-5 flex items-center gap-2.5 rounded-[6px] border border-[#D4C7AE] bg-[#EAE1CF]/50 px-4 py-3">
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#8B4A52] border-t-transparent" />
        <span className="text-sm text-[#5A4F42]">Analysing session notes…</span>
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
              The AI will read your session notes and update entity pages — creating new
              NPCs, locations, or creatures it finds, and adding backlinks. This takes a
              few moments.
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
      onClick={handleClick}
      className="mb-5 rounded-[4px] bg-[#8B4A52] px-4 py-2 text-sm font-medium text-[#F4EDE0] transition-opacity hover:opacity-85 active:opacity-70"
    >
      End of Session
    </button>
  );
}
