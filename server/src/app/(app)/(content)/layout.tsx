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
import { GM_MODE_COOKIE, treeModeFor } from '@/lib/gm-mode';
import { listNoteKinds } from '@/lib/characters';
import { getWorldFeatures } from '@/lib/groups';
import { getDb } from '@/lib/db';
import { AppHeader } from '../../AppHeader';
import { NoteTabBar } from '../../NoteTabBar';
import { SidebarHeader } from '../../SidebarHeader';
import { SidebarFooter } from '../../SidebarFooter';
import { FileTree } from '../../notes/FileTree';
import { ActivePartySection } from '../../notes/ActivePartySection';
import { CollapsibleSidebar } from '../../CollapsibleSidebar';
import { NewSessionButton } from '../../NewSessionButton';

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

  const gmMode = treeModeFor(jar.get(GM_MODE_COOKIE)?.value, session.role) === 'gm';
  // In GM mode the world owner sees both namespaces stacked so they
  // can move/promote info between them. Build both trees up front;
  // either is cheap and the cache makes back-to-back calls a no-op.
  const playerTree = buildTree(session.currentGroupId, { mode: 'player' });
  const gmTree = gmMode ? buildTree(session.currentGroupId, { mode: 'gm' }) : null;
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));
  const features = getWorldFeatures(session.currentGroupId);
  const sidebarOpen = jar.get('compendium_sidebar_open')?.value !== 'false';

  const db = getDb();
  const groupRow = db
    .query<{ active_campaign_slug: string | null }, [string]>(
      'SELECT active_campaign_slug FROM groups WHERE id = ?',
    )
    .get(session.currentGroupId);
  const activeCampaignSlug =
    groupRow?.active_campaign_slug ??
    (db
      .query<{ slug: string }, [string]>(
        'SELECT slug FROM campaigns WHERE group_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(session.currentGroupId)?.slug ?? null);

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
        gmMode={gmMode}
      />
      <div className="flex min-h-0 flex-1">
        <CollapsibleSidebar initialOpen={sidebarOpen}>
          <SidebarHeader role={session.role} features={features} />
          <NewSessionButton
            campaignSlug={activeCampaignSlug}
            csrfToken={session.csrfToken}
            canCreate={session.role !== 'viewer'}
          />
          <div className="shrink-0 px-2 pt-3">
            <ActivePartySection
              groupId={session.currentGroupId}
              activeCampaignSlug={activeCampaignSlug}
              csrfToken={session.csrfToken}
            />
          </div>
          {gmTree && (
            <FileTree
              tree={gmTree}
              groupId={session.currentGroupId}
              csrfToken={session.csrfToken}
              canCreate={session.role !== 'viewer'}
              isWorldOwner={session.role === 'admin'}
              kindMap={kindMap}
              activeCampaignSlug={activeCampaignSlug}
              sectionTone="gm"
              storageNamespace="gm"
            />
          )}
          <FileTree
            tree={playerTree}
            groupId={session.currentGroupId}
            csrfToken={session.csrfToken}
            canCreate={session.role !== 'viewer'}
            isWorldOwner={session.role === 'admin'}
            kindMap={kindMap}
            activeCampaignSlug={activeCampaignSlug}
            {...(gmMode ? { sectionTone: 'players' as const, storageNamespace: 'player' } : {})}
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
