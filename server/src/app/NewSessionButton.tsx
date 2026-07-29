'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus } from 'lucide-react';

// Phase-based state, matching the pattern in notes/EndSessionButton.tsx —
// see that file for the convention this mirrors.
type Phase = 'idle' | 'working' | 'error';

// POST /api/sessions/create returns { error: 'snake_case_code', reason?,
// detail? } per the project's API error shape. Map the codes a real user
// could hit to plain language; anything else falls back to reason/detail
// or the HTTP status.
const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You don't have permission to create sessions.",
  unknown_campaign: 'No active campaign found for this world.',
  exists: 'A session for today already exists.',
};

export function NewSessionButton({
  campaignSlug,
  csrfToken,
  canCreate,
}: {
  campaignSlug: string | null;
  csrfToken: string;
  canCreate: boolean;
}): React.JSX.Element | null {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  if (!canCreate || !campaignSlug) return null;

  async function handleClick(): Promise<void> {
    if (phase === 'working') return;
    setPhase('working');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch('/api/sessions/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ campaignSlug, date: today }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        path?: string;
        error?: string;
        reason?: string;
        detail?: string;
      };
      if ((res.ok || res.status === 409) && data.path) {
        router.push('/notes/' + data.path.split('/').map(encodeURIComponent).join('/'));
        router.refresh();
        setPhase('idle');
        return;
      }
      // Either a non-ok/non-409 response, or the server didn't hand back a
      // path — both mean the note wasn't created (or can't be found), so
      // surface it instead of silently doing nothing.
      console.error('[NewSessionButton]', data.error ?? `HTTP ${res.status}`);
      setErrorMsg(
        (data.error && ERROR_MESSAGES[data.error]) ??
          data.reason ??
          data.detail ??
          `Couldn't create the session (HTTP ${res.status}).`,
      );
      setPhase('error');
    } catch (err) {
      console.error('[NewSessionButton]', err);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create session.');
      setPhase('error');
    }
  }

  if (phase === 'error') {
    return (
      <div className="shrink-0 border-b border-[var(--rule)] px-3 py-2">
        <div className="rounded-[6px] border border-[var(--wine)]/40 bg-[var(--wine)]/8 px-3 py-2">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--wine)]">
            Error
          </p>
          <p className="mb-2 text-xs text-[var(--ink)]">{errorMsg}</p>
          <button
            onClick={() => setPhase('idle')}
            className="text-xs text-[var(--wine)] underline underline-offset-2 hover:opacity-70"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-[var(--rule)] px-3 py-2">
      <button
        onClick={() => void handleClick()}
        disabled={phase === 'working'}
        title="Create a session note for today in the latest campaign"
        className="flex w-full items-center gap-2 rounded-[6px] bg-[var(--candlelight)]/15 px-3 py-1.5 text-sm font-medium text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/30 hover:text-[var(--ink)] disabled:opacity-50"
      >
        <CalendarPlus size={14} aria-hidden />
        {phase === 'working' ? 'Creating…' : '+ New Session'}
      </button>
    </div>
  );
}
