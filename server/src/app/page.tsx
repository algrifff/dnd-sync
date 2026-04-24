import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { isGroupMember } from '@/lib/groups';
import { LandingClient } from './LandingClient';
import { ThemeToggle } from './ThemeToggle';

export const dynamic = 'force-dynamic';

export default async function RootPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader, false);
  if (session) {
    // Returning users with a valid active world land on that world's
    // /home. First logins (no currentGroupId) and users whose last
    // world was deleted or revoked fall through to /me, the personal
    // overview, where they can create a world or join one.
    if (session.currentGroupId && isGroupMember(session.userId, session.currentGroupId)) {
      redirect('/home');
    }
    redirect('/me');
  }
  return (
    <>
      <ThemeToggle />
      <LandingClient />
    </>
  );
}
