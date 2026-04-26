'use client';

// Client island for the "Links to" section. Mirrors BacklinksPanel —
// shows an × on hover for manual links so the user can drop them
// without editing note content. Body-derived wikilinks (is_manual=0)
// must be removed from the source content; we hide × on those.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import type { OutgoingLinkRow } from '@/lib/notes';
import { AddOutgoingLink } from './AddOutgoingLink';

export function OutgoingLinksPanel({
  initialOutgoingLinks,
  currentPath,
  csrfToken,
}: {
  initialOutgoingLinks: OutgoingLinkRow[];
  currentPath: string;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const [links, setLinks] = useState<OutgoingLinkRow[]>(initialOutgoingLinks);

  useEffect(() => {
    setLinks(initialOutgoingLinks);
  }, [initialOutgoingLinks]);

  const remove = useCallback(
    (toPath: string): void => {
      setLinks((prev) => prev.filter((l) => l.to_path !== toPath));
      void fetch('/api/notes/backlink', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ fromPath: currentPath, toPath }),
      }).finally(() => {
        router.refresh();
      });
    },
    [csrfToken, currentPath, router],
  );

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Links to
        </h3>
        <AddOutgoingLink currentPath={currentPath} csrfToken={csrfToken} />
      </div>

      {links.length === 0 ? (
        <p className="text-xs text-[var(--ink-soft)]/80">No outgoing links.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {links.map((l) => (
            <li key={l.to_path} className="group flex items-center gap-0.5">
              <Link
                href={'/notes/' + encodePath(l.to_path)}
                title={l.to_path}
                className="inline-block max-w-[160px] truncate rounded-full border border-[var(--rule)] bg-[var(--vellum)] px-2.5 py-0.5 text-xs text-[var(--ink)] transition hover:-translate-y-px hover:border-[var(--candlelight)] hover:bg-[var(--parchment)]"
              >
                {l.title || baseName(l.to_path)}
              </Link>
              <button
                type="button"
                onClick={() => remove(l.to_path)}
                title={`Remove link to ${baseName(l.to_path)}`}
                aria-label={`Remove outgoing link to ${baseName(l.to_path)}`}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--ink-soft)] opacity-0 transition hover:bg-[var(--wine)]/15 hover:text-[var(--wine)] group-hover:opacity-100"
              >
                <X size={10} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function baseName(p: string): string {
  const last = p.split('/').pop() ?? p;
  return last.replace(/\.(md|canvas)$/i, '');
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
