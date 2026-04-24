// /me — personal overview. Lives outside the (content) route group so
// it skips the world-scoped chrome (FileTree, AppHeader, ChatPane).
// Shows the user's worlds, their user-level characters, and recent
// activity across every world they belong to.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listWorldsForSession } from '@/lib/groups';
import { listRecentForUser } from '@/lib/notes';
import { listUserCharacters } from '@/lib/userCharacters';
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
    <MeDashboard
      csrfToken={session.csrfToken}
      displayName={session.displayName}
      worlds={worlds}
      characters={characters}
      recent={recent}
    />
  );
}
