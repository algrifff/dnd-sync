// /graph — full-viewport mind-map of the current vault. Server
// component for the app shell; the interactive canvas is a client
// island (graphology + sigma + forceatlas2 layout worker).

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { buildTree } from '@/lib/tree';
import { listAllTags } from '@/lib/notes';
import { AppHeader } from '../AppHeader';
import { SidebarHeader } from '../SidebarHeader';
import { SidebarFooter } from '../SidebarFooter';
import { FileTree } from '../notes/FileTree';
import { GraphCanvas } from './GraphCanvas';

export const dynamic = 'force-dynamic';

export default async function GraphPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/graph');

  const tree = buildTree(session.currentGroupId);
  const allTags = listAllTags(session.currentGroupId).map((t) => t.tag);

  return (
    <div className="flex h-screen bg-[#F4EDE0] text-[#2A241E]">
      <aside className="hidden h-full w-[260px] shrink-0 flex-col bg-[#EAE1CF]/60 md:flex">
        <SidebarHeader role={session.role} />
        <FileTree
          tree={tree}
          activePath=""
          groupId={session.currentGroupId}
          csrfToken={session.csrfToken}
          canCreate={session.role !== 'viewer'}
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
        <div className="relative flex-1 overflow-hidden">
          <GraphCanvas
            groupId={session.currentGroupId}
            allTags={allTags}
            me={{
              userId: session.userId,
              displayName: session.displayName,
              accentColor: session.accentColor,
              cursorMode: session.cursorMode,
              avatarVersion: session.avatarVersion,
            }}
          />
        </div>
      </div>
    </div>
  );
}
