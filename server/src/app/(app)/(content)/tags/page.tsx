// Tags index. Shell owned by (content)/layout — this page is only
// the inner content column.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listAllTags } from '@/lib/notes';
import { TagsFilterBar } from '../../../tags/TagsFilterBar';

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
    <div className="flex-1 overflow-y-auto">
      <main className="mx-auto max-w-[960px] px-8 py-10">
        <h1
          className="mb-8 text-3xl font-bold text-[#2A241E]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Tags
        </h1>
        <TagsFilterBar tags={tags} />
      </main>
    </div>
  );
}
