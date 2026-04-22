import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { buildTree } from '@/lib/tree';
import { listNoteKinds } from '@/lib/characters';
import { listGroupAssetsWithTags } from '@/lib/assets';
import { AppHeader } from '../../AppHeader';
import { NoteTabBar } from '../../NoteTabBar';
import { SidebarHeader } from '../../SidebarHeader';
import { SidebarFooter } from '../../SidebarFooter';
import { FileTree } from '../../notes/FileTree';
import { AssetsGallery } from '../../assets/AssetsGallery';

export const dynamic = 'force-dynamic';

export default async function AssetsPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/assets');

  const tree = buildTree(session.currentGroupId);
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));
  const assets = listGroupAssetsWithTags(session.currentGroupId);

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
          <div className="flex-1 overflow-y-auto px-6 py-8">
            <div className="mx-auto max-w-6xl">
              <h1 className="mb-1 text-3xl font-bold" style={{ fontFamily: '"Fraunces", Georgia, serif' }}>
                Assets
              </h1>
              <p className="mb-6 text-sm text-[#5A4F42]">
                Every image, map, and token uploaded to this vault. Click a tile to open a full-size
                preview.
              </p>
              <AssetsGallery
                assets={assets}
                csrfToken={session.csrfToken}
                canEdit={session.role !== 'viewer'}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
