// Tag detail page. Shell owned by (content)/layout.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listNotesByTag } from '@/lib/notes';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ tag: string }> };

export default async function TagDetailPage({ params }: Ctx): Promise<ReactElement> {
  const { tag: raw } = await params;
  const tag = decodeURIComponent(raw).replace(/^#/, '').toLowerCase();
  if (!/^[a-zA-Z0-9_\-/]+$/.test(tag)) notFound();

  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) notFound();

  const notes = listNotesByTag(session.currentGroupId, tag);

  return (
    <div className="flex-1 overflow-y-auto">
      <main className="mx-auto max-w-[960px] px-8 py-10">
        <p className="mb-2 text-xs text-[var(--ink-soft)]">
          <Link href="/tags" className="underline-offset-2 hover:underline">
            ← All tags
          </Link>
        </p>
        <h1
          className="mb-2 text-3xl font-bold text-[var(--ink)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          <span className="text-[#5E3A3F]">#</span>
          {tag}
        </h1>
        <p className="mb-8 text-sm text-[var(--ink-soft)]">
          {notes.length} note{notes.length === 1 ? '' : 's'} with this tag.
        </p>

        {notes.length === 0 ? (
          <p className="text-sm text-[var(--ink-soft)]">Nothing yet.</p>
        ) : (
          <ul className="space-y-1">
            {notes.map((n) => (
              <li key={n.path}>
                <Link
                  href={'/notes/' + n.path.split('/').map(encodeURIComponent).join('/')}
                  className="flex items-baseline justify-between gap-4 rounded-[6px] px-2 py-1.5 transition hover:bg-[var(--candlelight)]/15"
                >
                  <span className="truncate text-[var(--ink)]">{n.title || n.path}</span>
                  <span className="shrink-0 font-mono text-xs text-[var(--ink-soft)]">{n.path}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
