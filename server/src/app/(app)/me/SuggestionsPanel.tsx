'use client';

// "Suggestions for you": what Wrap-ups have offered the Player's
// Characters. Each one waits here until the Player accepts it (a History
// entry plus any items) or dismisses it. Nothing about a Character
// changes until then, and game stats never do. Renders nothing when
// there is nothing to decide.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import type { PendingSuggestion } from '@/lib/character-suggestions';
import { itemsLabel } from '../../notes/wrap-up-review';

export function SuggestionsPanel({ csrfToken }: { csrfToken: string }): React.JSX.Element | null {
  const [suggestions, setSuggestions] = useState<PendingSuggestion[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/suggestions', { credentials: 'same-origin' });
      if (!res.ok) return;
      setSuggestions(((await res.json()) as { suggestions: PendingSuggestion[] }).suggestions);
    } catch {
      /* the panel is optional: stay hidden */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(id: string, action: 'accept' | 'dismiss'): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/suggestions/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
        throw new Error(data.reason ?? data.error ?? `Something went wrong (HTTP ${res.status}).`);
      }
      setSuggestions((all) => all.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the Suggestion.');
      void load();
    } finally {
      setBusyId(null);
    }
  }

  if (suggestions.length === 0 && !error) return null;

  return (
    <section aria-labelledby="suggestions-heading" className="mb-10">
      <h2 id="suggestions-heading" className="font-serif text-lg text-[var(--ink)]">
        Suggestions for you
      </h2>
      <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
        From your latest Wrap-ups. Accepting adds to your Character&rsquo;s History and inventory.
        Your stats are never changed.
      </p>
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-[6px] border border-[var(--wine)]/40 bg-[rgb(var(--wine-rgb)/0.08)] px-3 py-2 text-xs text-[var(--wine)]"
        >
          {error}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {suggestions.map((s) => {
          const busy = busyId === s.id;
          return (
            <li key={s.id} className="rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] p-3">
              <p className="text-sm font-medium text-[var(--ink)]">
                <Link
                  href={`/notes/${s.characterPath.split('/').map(encodeURIComponent).join('/')}`}
                  className="hover:underline"
                >
                  {s.characterTitle}
                </Link>{' '}
                <span className="font-normal text-[var(--ink-soft)]">· {s.sessionTitle}</span>
              </p>
              {s.story && <p className="mt-1 text-sm text-[var(--ink)]">{s.story}</p>}
              {s.items.length > 0 && (
                <p className="mt-1 text-xs text-[var(--ink-soft)]">Items: {itemsLabel(s.items)}</p>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(s.id, 'accept')}
                  className="inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--wine)] px-3 py-1.5 text-xs font-semibold text-[var(--vellum)] transition hover:opacity-90 disabled:opacity-50"
                >
                  {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(s.id, 'dismiss')}
                  className="rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
                >
                  Dismiss
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
