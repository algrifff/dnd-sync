// /me — personal overview. Lives outside the (content) route group so
// it skips the world-scoped chrome (FileTree, AppHeader).
// Shows the user's worlds, their user-level characters, and recent
// activity across every world they belong to.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listWorldsForSession } from '@/lib/groups';
import { listRecentForUser } from '@/lib/notes';
import { listUserCharacters } from '@/lib/userCharacters';
import { MobileNavProvider } from '../../MobileNavContext';
import { MobileNavInertBoundary } from '../../MobileNavInertBoundary';
import { MobileNavDrawer } from '../../MobileNavDrawer';
import { MeDashboard } from './MeDashboard';

export const dynamic = 'force-dynamic';

export default async function MePage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/me');

  const worlds = listWorldsForSession(session.userId, session.id);
  const characters = listUserCharacters(session.userId);
  const recent = listRecentForUser(session.userId, 20);

  return (
    <MobileNavProvider>
      <MobileNavInertBoundary className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MeDashboard
          csrfToken={session.csrfToken}
          displayName={session.displayName}
          worlds={worlds}
          characters={characters}
          recent={recent}
        />
      </MobileNavInertBoundary>
      <MobileNavDrawer
        csrfToken={session.csrfToken}
        userId={session.userId}
        displayName={session.displayName}
        accentColor={session.accentColor}
        avatarVersion={session.avatarVersion}
        role={session.role}
        worldId={session.currentGroupId}
      />
    </MobileNavProvider>
  );
}
