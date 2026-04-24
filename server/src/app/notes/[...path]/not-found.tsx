// Rendered when a /notes/<path> route points at a note that no longer
// exists in the DB (deleted or renamed by a peer). Server component
// for the shell + a small client island (TabCleaner) that prunes the
// stale path from the local tabs list and routes home.

import type { ReactElement } from 'react';
import Link from 'next/link';
import { TabCleaner } from './TabCleaner';

export default function NoteNotFound(): ReactElement {
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-10">
      <div className="max-w-md rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-6 text-center">
        <h1
          className="mb-2 text-2xl font-semibold text-[var(--ink)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Note no longer exists
        </h1>
        <p className="text-sm text-[var(--ink-soft)]">
          Someone deleted or moved this note. Closing the tab in a moment.
        </p>
        <div className="mt-4">
          <Link
            href="/home"
            className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-sm text-[var(--ink)] transition hover:bg-[var(--parchment-sunk)]"
          >
            Go home
          </Link>
        </div>
        <TabCleaner />
      </div>
    </main>
  );
}
