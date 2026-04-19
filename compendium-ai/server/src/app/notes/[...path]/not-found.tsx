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
      <div className="max-w-md rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-6 text-center">
        <h1
          className="mb-2 text-2xl font-semibold text-[#2A241E]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Note no longer exists
        </h1>
        <p className="text-sm text-[#5A4F42]">
          Someone deleted or moved this note. Closing the tab in a moment.
        </p>
        <div className="mt-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E] transition hover:bg-[#EAE1CF]"
          >
            Go home
          </Link>
        </div>
        <TabCleaner />
      </div>
    </main>
  );
}
