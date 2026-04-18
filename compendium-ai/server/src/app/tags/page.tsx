// /tags — the group-global tag index. One chip per tag with its count;
// clicking drills into /tags/<tag> to see every note that uses it.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listAllTags } from '@/lib/notes';
import { AppHeader } from '../AppHeader';

export const dynamic = 'force-dynamic';

export default async function TagsIndexPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) notFound();

  const tags = listAllTags(session.currentGroupId);

  return (
    <div className="min-h-screen bg-[#F4EDE0] text-[#2A241E]">
      <AppHeader
        role={session.role}
        includeNav
        user={{
          displayName: session.displayName,
          username: session.username,
          accentColor: session.accentColor,
        }}
      />

      <main className="mx-auto max-w-[960px] px-8 py-10">
        <h1
          className="mb-2 text-3xl font-bold text-[#2A241E]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Tags
        </h1>
        <p className="mb-8 text-sm text-[#5A4F42]">
          {tags.length} tag{tags.length === 1 ? '' : 's'} across the vault.
        </p>

        {tags.length === 0 ? (
          <p className="text-sm text-[#5A4F42]">
            No tags yet. Add one from any note.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <li key={t.tag}>
                <Link
                  href={'/tags/' + encodeURIComponent(t.tag)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-1 text-sm font-medium text-[#5E3A3F] transition hover:-translate-y-px hover:bg-[#8B4A52]/20 hover:text-[#4A2E32]"
                >
                  <span>#{t.tag}</span>
                  <span className="rounded-full bg-[#8B4A52]/20 px-1.5 text-xs text-[#5E3A3F]/80">
                    {t.count}
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
