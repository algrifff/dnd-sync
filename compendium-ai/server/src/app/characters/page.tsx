// /characters — per-user character dashboard. Lists the PCs the
// signed-in user owns, grouped by campaign, with quick links into
// each sheet and a "Set active" action.
//
// For admins + editors we also surface a "Characters in this vault"
// section listing every character (regardless of owner) so DMs can
// page through their roster.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { buildTree } from '@/lib/tree';
import {
  listCampaigns,
  listCharacters,
  listNoteKinds,
  type CharacterListRow,
} from '@/lib/characters';
import { AppHeader } from '../AppHeader';
import { WorldsSidebar } from '../WorldsSidebar';
import { SidebarHeader } from '../SidebarHeader';
import { SidebarFooter } from '../SidebarFooter';
import { FileTree } from '../notes/FileTree';
import { ActiveCharacterBlock } from '../notes/ActiveCharacterBlock';
import { CharactersDashboard } from './CharactersDashboard';

export const dynamic = 'force-dynamic';

export default async function CharactersPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/characters');

  const tree = buildTree(session.currentGroupId, {
    hideDmOnly: session.role === 'viewer',
  });
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));
  const campaigns = listCampaigns(session.currentGroupId);
  const mine = listCharacters(session.currentGroupId, {
    playerUserId: session.userId,
  });
  const all =
    session.role === 'admin' || session.role === 'editor'
      ? listCharacters(session.currentGroupId)
      : [];

  return (
    <div className="flex h-screen bg-[#F4EDE0] text-[#2A241E]">
      <WorldsSidebar csrfToken={session.csrfToken} />
      <aside className="hidden h-full w-[260px] shrink-0 flex-col bg-[#EAE1CF]/60 md:flex">
        <SidebarHeader role={session.role} />
        <ActiveCharacterBlock
          csrfToken={session.csrfToken}
          initialActivePath={session.activeCharacterPath}
        />
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
          <div className="mx-auto max-w-4xl">
            <h1
              className="mb-1 text-3xl font-bold"
              style={{ fontFamily: '"Fraunces", Georgia, serif' }}
            >
              Characters
            </h1>
            <p className="mb-6 text-sm text-[#5A4F42]">
              Pinned as your active character shows up in the sidebar and
              labels your presence in shared sessions.
            </p>
            <CharactersDashboard
              csrfToken={session.csrfToken}
              mine={mine satisfies CharacterListRow[]}
              others={all.filter((c) => c.playerUserId !== session.userId)}
              activeCharacterPath={session.activeCharacterPath}
              campaignNames={Object.fromEntries(
                campaigns.map((c) => [c.slug, c.name]),
              )}
              isAdmin={session.role === 'admin' || session.role === 'editor'}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export type { CharacterListRow };
