// Shared shell for every /settings/* route. Profile settings only —
// vault, users, and templates have moved to /admin.

import type { ReactElement, ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { buildTree } from '@/lib/tree';
import { listNoteKinds } from '@/lib/characters';
import { AppHeader } from '../AppHeader';
import { WorldsSidebar } from '../WorldsSidebar';
import { SidebarHeader } from '../SidebarHeader';
import { SidebarFooter } from '../SidebarFooter';
import { FileTree } from '../notes/FileTree';
import { ActiveCharacterBlock } from '../notes/ActiveCharacterBlock';
import { SettingsTabs } from './SettingsTabs';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/settings');

  const tree = buildTree(session.currentGroupId);
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));

  return (
    <div className="flex h-screen bg-[#F4EDE0] text-[#2A241E]">
      <WorldsSidebar csrfToken={session.csrfToken} />
      <aside className="hidden h-full w-[260px] shrink-0 flex-col bg-[#EAE1CF]/60 md:flex">
        <ActiveCharacterBlock
          csrfToken={session.csrfToken}
          initialActivePath={session.activeCharacterPath}
        />
        <SidebarHeader role={session.role} />
        <FileTree
          tree={tree}
          activePath=""
          groupId={session.currentGroupId}
          csrfToken={session.csrfToken}
          canCreate={session.role !== 'viewer'}
          kindMap={kindMap}
        />
        <SidebarFooter
          displayName={session.displayName}
          username={session.username}
          role={session.role}
          accentColor={session.accentColor}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          role={session.role}
          me={{
            userId: session.userId,
            displayName: session.displayName,
            username: session.username,
            accentColor: session.accentColor,
          }}
          csrfToken={session.csrfToken}
          canCreate={session.role !== 'viewer'}
        />
        <div className="flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto max-w-3xl">
            <h1
              className="mb-1 text-3xl font-bold"
              style={{ fontFamily: '"Fraunces", Georgia, serif' }}
            >
              Settings
            </h1>
            <p className="mb-6 text-sm text-[#5A4F42]">
              Change how you look and what you sign in with.
            </p>
            <SettingsTabs />
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
