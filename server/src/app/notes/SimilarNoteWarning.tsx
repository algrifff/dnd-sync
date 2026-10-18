'use client';

// "Already exists" hint under a name being typed for a new Note. Looks up
// Notes with a close name after the typing pauses and offers to open one
// or carry on. It never blocks: creating anyway is always one click, and
// the hint stays quiet if the lookup fails.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Link2 } from 'lucide-react';
import type { SimilarNote } from '@/lib/similar-names';

const DEBOUNCE_MS = 300;
const MIN_LENGTH = 3;

/** Close-named Notes for `name`, settled 300 ms after the last keystroke. */
export function useSimilarNotes(name: string, enabled: boolean): SimilarNote[] {
  const [found, setFound] = useState<{ name: string; matches: SimilarNote[] } | null>(null);
  const trimmed = name.trim();

  useEffect(() => {
    if (!enabled || trimmed.length < MIN_LENGTH) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/notes/similar?name=${encodeURIComponent(trimmed)}`, {
        credentials: 'same-origin',
        signal: controller.signal,
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ matches: SimilarNote[] }>) : null))
        .then((data) => {
          if (data) setFound({ name: trimmed, matches: data.matches });
        })
        .catch(() => undefined);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, enabled]);

  // A result for an earlier spelling is not shown against the current one.
  return enabled && found?.name === trimmed ? found.matches : [];
}

const KIND_LABEL = (kind: string): string => kind.charAt(0).toUpperCase() + kind.slice(1);

export function SimilarNoteWarning({
  matches,
  onOpen,
  onCreateAnyway,
}: {
  matches: SimilarNote[];
  /** Called as the link to an existing Note is followed. */
  onOpen: () => void;
  onCreateAnyway: () => void;
}): React.JSX.Element | null {
  if (matches.length === 0) return null;
  // The buttons must not take focus from the name input: its blur would
  // create the Note before the click lands.
  const keepFocus = (e: React.MouseEvent): void => e.preventDefault();
  return (
    <ul role="status" className="mt-1 space-y-1 pr-2 text-xs text-[var(--ink-soft)]">
      {matches.map((m) => (
        <li key={m.path} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="[overflow-wrap:anywhere]">
            <strong className="font-semibold text-[var(--ink)]">{m.title}</strong>
            {` (${KIND_LABEL(m.kind)}) already exists`}
          </span>
          <Link
            href={'/notes/' + m.path.split('/').map(encodeURIComponent).join('/')}
            onMouseDown={keepFocus}
            onClick={onOpen}
            className="inline-flex items-center gap-1 font-medium text-[var(--wine)] underline-offset-2 hover:underline"
          >
            <Link2 size={11} aria-hidden />
            Open it
          </Link>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onCreateAnyway}
            className="font-medium text-[var(--ink-soft)] underline-offset-2 hover:underline"
          >
            Create anyway
          </button>
        </li>
      ))}
    </ul>
  );
}
