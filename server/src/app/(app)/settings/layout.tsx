import type { ReactElement, ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { buildTree } from '@/lib/tree';
import { GM_MODE_COOKIE, treeModeFor } from '@/lib/gm-mode';
import { listNoteKinds } from '@/lib/characters';
import { getWorldFeatures } from '@/lib/groups';
import { AppHeader } from '../../AppHeader';
import { NoteTabBar } from '../../NoteTabBar';
import { SidebarHeader } from '../../SidebarHeader';
import { SidebarFooter } from '../../SidebarFooter';
import { FileTree } from '../../notes/FileTree';
import { SettingsTabs } from '../../settings/SettingsTabs';
import { SettingsHeading } from '../../settings/SettingsHeading';

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

  const gmMode = treeModeFor(jar.get(GM_MODE_COOKIE)?.value, session.role) === 'gm';
  const playerTree = buildTree(session.currentGroupId, { mode: 'player' });
  const gmTree = gmMode ? buildTree(session.currentGroupId, { mode: 'gm' }) : null;
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));
  const features = getWorldFeatures(session.currentGroupId);

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
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden h-full w-[260px] shrink-0 flex-col bg-[var(--parchment-sunk)]/60 md:flex">
          <SidebarHeader role={session.role} features={features} />
          {gmTree && (
            <FileTree
              tree={gmTree}
              activePath=""
              groupId={session.currentGroupId}
              csrfToken={session.csrfToken}
              canCreate={session.role !== 'viewer'}
              isWorldOwner={session.role === 'admin'}
              kindMap={kindMap}
              sectionTone="gm"
              storageNamespace="gm"
            />
          )}
          <FileTree
            tree={playerTree}
            activePath=""
            groupId={session.currentGroupId}
            csrfToken={session.csrfToken}
            canCreate={session.role !== 'viewer'}
            isWorldOwner={session.role === 'admin'}
            kindMap={kindMap}
            {...(gmMode ? { sectionTone: 'players' as const, storageNamespace: 'player' } : {})}
          />
          <SidebarFooter username={session.username} />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <NoteTabBar />
          <div className="flex-1 overflow-y-auto px-6 py-8">
            <div className="mx-auto max-w-3xl">
              <SettingsHeading />
              <SettingsTabs />
              <div className="mt-6">{children}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
