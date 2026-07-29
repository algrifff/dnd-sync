// Rendered when a /notes/<path> route points at a note that no longer
// exists in the DB (deleted or renamed by a peer, or a stale/typo'd
// link). Server component for the shell + a small client island
// (TabCleaner) that prunes the stale path from the local tabs list and
// routes home.
//
// This lives in the SAME route group as the page it guards
// ((app)/(content)/notes/[...path]/page.tsx) — route groups are
// path-transparent for the URL but NOT for the file-system layout
// hierarchy that Next uses to resolve `notFound()` boundaries. A
// not-found.tsx under the plain `app/notes/[...path]/` directory (no
// route groups) is a different segment tree with no page.tsx of its
// own, so it can never fire; `notFound()` calls here used to fall
// through to Next's bare, unstyled default 404. See that directory's
// git history — it's been removed now that this is in place.
//
// Rendered inside ContentLayout, so the app chrome (header, sidebar,
// tab bar) stays up around this — only the main content area shows
// the "gone" state.

import type { ReactElement } from 'react';
import Link from 'next/link';
import { TabCleaner } from './TabCleaner';

export default function NoteNotFound(): ReactElement {
  return (
    <main className="flex min-h-[60vh] flex-1 items-center justify-center px-6 py-10">
      <div className="max-w-md rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-6 text-center shadow-[0_8px_24px_rgb(var(--ink-rgb)/0.12)]">
        <h1
          className="mb-2 text-2xl font-semibold text-[var(--ink)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Note no longer exists
        </h1>
        <p className="text-sm text-[var(--ink-soft)]">
          It was deleted or moved — by you, or someone else at the table.
          Closing this tab in a moment.
        </p>
        <div className="mt-4">
          <Link
            href="/home"
            className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-sm text-[var(--ink)] transition hover:bg-[var(--parchment-sunk)]"
          >
            Go to dashboard
          </Link>
        </div>
        <TabCleaner />
      </div>
    </main>
  );
}
