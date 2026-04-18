// /tags/<tag> — every note in the group that carries this tag. The
// list joins the tag-index + notes tables, so both inline #mentions
// and explicit frontmatter.tags surface here.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listNotesByTag } from '@/lib/notes';
import { AppHeader } from '../../AppHeader';

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
    <div className="min-h-screen bg-[#F4EDE0] text-[#2A241E]">
      <AppHeader
        role={session.role}
        user={{
          displayName: session.displayName,
          username: session.username,
          accentColor: session.accentColor,
        }}
      />

      <main className="mx-auto max-w-[960px] px-8 py-10">
        <p className="mb-2 text-xs text-[#5A4F42]">
          <Link href="/tags" className="underline-offset-2 hover:underline">
            ← All tags
          </Link>
        </p>
        <h1
          className="mb-2 text-3xl font-bold text-[#2A241E]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          <span className="text-[#5E3A3F]">#</span>
          {tag}
        </h1>
        <p className="mb-8 text-sm text-[#5A4F42]">
          {notes.length} note{notes.length === 1 ? '' : 's'} with this tag.
        </p>

        {notes.length === 0 ? (
          <p className="text-sm text-[#5A4F42]">Nothing yet.</p>
        ) : (
          <ul className="space-y-1">
            {notes.map((n) => (
              <li key={n.path}>
                <Link
                  href={'/notes/' + n.path.split('/').map(encodeURIComponent).join('/')}
                  className="flex items-baseline justify-between gap-4 rounded-[6px] px-2 py-1.5 transition hover:bg-[#D4A85A]/15"
                >
                  <span className="truncate text-[#2A241E]">{n.title || n.path}</span>
                  <span className="shrink-0 font-mono text-xs text-[#5A4F42]">
                    {n.path}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
