'use client';

// Client island for the Backlinks section of the note sidebar.
// Accepts the server-rendered initial list and manages it locally so
// the × remove button can optimistically drop an entry without a full
// page reload. router.refresh() is called after each mutation so the
// server state eventually catches up (AddBacklink's + button relies on
// this to show newly-added entries).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import type { BacklinkRow } from '@/lib/notes';
import { AddBacklink } from './AddBacklink';

export function BacklinksPanel({
  initialBacklinks,
  currentPath,
  csrfToken,
}: {
  initialBacklinks: BacklinkRow[];
  currentPath: string;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const [backlinks, setBacklinks] = useState<BacklinkRow[]>(initialBacklinks);

  // Sync with server after router.refresh() re-renders the parent.
  useEffect(() => {
    setBacklinks(initialBacklinks);
  }, [initialBacklinks]);

  const remove = useCallback(
    (fromPath: string): void => {
      // Optimistic removal — drop from local state immediately.
      setBacklinks((prev) => prev.filter((b) => b.from_path !== fromPath));
      void fetch('/api/notes/backlink', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ fromPath, toPath: currentPath }),
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
          Backlinks
        </h3>
        <AddBacklink currentPath={currentPath} csrfToken={csrfToken} />
      </div>

      {backlinks.length === 0 ? (
        <p className="text-xs text-[var(--ink-soft)]/80">No backlinks yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {backlinks.map((b) => (
            <li key={b.from_path} className="group flex items-center gap-0.5">
              <Link
                href={'/notes/' + encodePath(b.from_path)}
                title={b.from_path}
                className="inline-block max-w-[160px] truncate rounded-full border border-[var(--rule)] bg-[var(--vellum)] px-2.5 py-0.5 text-xs text-[var(--ink)] transition hover:-translate-y-px hover:border-[var(--candlelight)] hover:bg-[var(--parchment)]"
              >
                {b.title || baseName(b.from_path)}
              </Link>
              {/* Only manual links (added via + or graph drag) can be removed
                  here. Body-derived links (is_manual=0) must be edited in the
                  source note's content. */}
              {b.is_manual === 1 && (
                <button
                  type="button"
                  onClick={() => remove(b.from_path)}
                  title={`Remove link from ${baseName(b.from_path)}`}
                  aria-label={`Remove backlink from ${baseName(b.from_path)}`}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--ink-soft)] opacity-0 transition hover:bg-[var(--wine)]/15 hover:text-[var(--wine)] group-hover:opacity-100"
                >
                  <X size={10} aria-hidden />
                </button>
              )}
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
