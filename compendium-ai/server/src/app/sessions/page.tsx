// /sessions — per-campaign chronological log. Each campaign gets a
// card; inside, sessions listed newest-first with date, session #,
// title, and attendee count. Click through to the session note.
//
// Admins + editors see a "+ New session" affordance on each campaign;
// viewers can't create sessions (it's a DM workflow).

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { buildTree } from '@/lib/tree';
import { listCampaigns, listNoteKinds } from '@/lib/characters';
import { listSessions } from '@/lib/sessions';
import { AppHeader } from '../AppHeader';
import { SidebarHeader } from '../SidebarHeader';
import { SidebarFooter } from '../SidebarFooter';
import { FileTree } from '../notes/FileTree';
import { ActiveCharacterBlock } from '../notes/ActiveCharacterBlock';
import { SessionsDashboard } from './SessionsDashboard';

export const dynamic = 'force-dynamic';

export default async function SessionsPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/sessions');

  const tree = buildTree(session.currentGroupId);
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));
  const campaigns = listCampaigns(session.currentGroupId);
  const sessions = listSessions(session.currentGroupId);

  return (
    <div className="flex h-screen bg-[#F4EDE0] text-[#2A241E]">
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
              Sessions
            </h1>
            <p className="mb-6 text-sm text-[#5A4F42]">
              Every campaign&rsquo;s session log. Newest at the top.
            </p>
            <SessionsDashboard
              csrfToken={session.csrfToken}
              canCreate={session.role !== 'viewer'}
              campaigns={campaigns.map((c) => ({ slug: c.slug, name: c.name }))}
              sessions={sessions.map((s) => ({
                notePath: s.notePath,
                campaignSlug: s.campaignSlug,
                sessionDate: s.sessionDate,
                sessionNumber: s.sessionNumber,
                title: s.title,
                attendees: s.attendees,
              }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
