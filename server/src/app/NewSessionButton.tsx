'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus } from 'lucide-react';

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
  const [loading, setLoading] = useState(false);

  if (!canCreate || !campaignSlug) return null;

  async function handleClick(): Promise<void> {
    if (loading) return;
    setLoading(true);
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
      const data = (await res.json()) as { path?: string };
      if ((res.ok || res.status === 409) && data.path) {
        router.push('/notes/' + data.path.split('/').map(encodeURIComponent).join('/'));
        router.refresh();
      }
    } catch (err) {
      console.error('[NewSessionButton]', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="shrink-0 border-b border-[var(--rule)] px-3 py-2">
      <button
        onClick={handleClick}
        disabled={loading}
        title="Create a session note for today in the latest campaign"
        className="flex w-full items-center gap-2 rounded-[6px] bg-[var(--candlelight)]/15 px-3 py-1.5 text-sm font-medium text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/30 hover:text-[var(--ink)] disabled:opacity-50"
      >
        <CalendarPlus size={14} aria-hidden />
        {loading ? 'Creating…' : '+ New Session'}
      </button>
    </div>
  );
}
