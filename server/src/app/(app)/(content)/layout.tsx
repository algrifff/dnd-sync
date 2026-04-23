// Persistent shell for all "main app" pages — home, notes, tags,
// graph, assets. Holds the AppHeader, FileTree sidebar, and the tab
// bar so navigating between pages in this group doesn't re-mount
// them. Without this layout, every /notes → /graph → /notes hop
// would redraw the whole chrome (sidebar flicker, tab titles flash)
// because each page re-rendered its own copy of these components.
//
// Settings has its own parallel layout (`../settings/layout.tsx`)
// because its UX is different enough — no ChatPane, no right panel,
// and a settings-tab strip instead of the main content area. Crossing
// into settings does re-mount the shell, but that navigation is rare.
//
// WorldsSidebar + WorldSwitchProvider stay in the parent (app)/layout
// so they also persist across `/settings` boundaries.

import type { ReactElement, ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { buildTree } from '@/lib/tree';
import { listNoteKinds } from '@/lib/characters';
import { AppHeader } from '../../AppHeader';
import { NoteTabBar } from '../../NoteTabBar';
import { SidebarHeader } from '../../SidebarHeader';
import { SidebarFooter } from '../../SidebarFooter';
import { FileTree } from '../../notes/FileTree';
import { CollapsibleSidebar } from '../../CollapsibleSidebar';

export const dynamic = 'force-dynamic';

export default async function ContentLayout({
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
  if (!session) redirect('/login?next=/');

  const tree = buildTree(session.currentGroupId);
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));
  const sidebarOpen = jar.get('compendium_sidebar_open')?.value !== 'false';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
      <div className="flex min-h-0 flex-1">
        <CollapsibleSidebar initialOpen={sidebarOpen}>
          <SidebarHeader role={session.role} />
          <FileTree
            tree={tree}
            groupId={session.currentGroupId}
            csrfToken={session.csrfToken}
            canCreate={session.role !== 'viewer'}
            isWorldOwner={session.role === 'admin'}
            kindMap={kindMap}
          />
          <SidebarFooter username={session.username} />
        </CollapsibleSidebar>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <NoteTabBar />
          {children}
        </div>
      </div>
    </div>
  );
}
