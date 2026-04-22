import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listAllTags } from '@/lib/notes';
import { buildTree } from '@/lib/tree';
import { listNoteKinds } from '@/lib/characters';
import { AppHeader } from '../../AppHeader';
import { NoteTabBar } from '../../NoteTabBar';
import { SidebarHeader } from '../../SidebarHeader';
import { SidebarFooter } from '../../SidebarFooter';
import { FileTree } from '../../notes/FileTree';
import { TagsFilterBar } from '../../tags/TagsFilterBar';

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
  const tree = buildTree(session.currentGroupId);
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <AppHeader
        role={session.role}
        me={{
          userId: session.userId,
          displayName: session.displayName,
          username: session.username,
          accentColor: session.accentColor,
          avatarVersion: session.avatarVersion,
        }}
        csrfToken={session.csrfToken}
        canCreate={session.role !== 'viewer'}
        groupId={session.currentGroupId}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden h-full w-[260px] shrink-0 flex-col bg-[#EAE1CF]/60 md:flex">
          <SidebarHeader role={session.role} />
          <FileTree
            tree={tree}
            activePath=""
            groupId={session.currentGroupId}
            csrfToken={session.csrfToken}
            canCreate={session.role !== 'viewer'}
            isWorldOwner={session.role === 'admin'}
            kindMap={kindMap}
          />
          <SidebarFooter username={session.username} />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <NoteTabBar canCreate={session.role !== 'viewer'} csrfToken={session.csrfToken} />
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
        </div>
      </div>
    </div>
  );
}
