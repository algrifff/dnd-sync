import type { ReactElement, ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { UpdateToast } from '../UpdateToast';
import { WorldsSidebar } from '../WorldsSidebar';
import { WorldSwitchOverlay, WorldSwitchProvider } from './WorldSwitch';

export const dynamic = 'force-dynamic';

export default async function AppLayout({
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

  return (
    <div className="flex h-screen overflow-hidden bg-[#F4EDE0] text-[#2A241E]">
      <WorldSwitchProvider
        csrfToken={session.csrfToken}
        activeWorldId={session.currentGroupId}
        userId={session.userId}
        username={session.username}
      >
        <WorldsSidebar
          csrfToken={session.csrfToken}
          userId={session.userId}
          displayName={session.displayName}
          accentColor={session.accentColor}
          avatarVersion={session.avatarVersion}
          role={session.role}
          worldId={session.currentGroupId}
        />
        <div className="relative flex min-w-0 flex-1 flex-col">
          {children}
          <WorldSwitchOverlay />
        </div>
      </WorldSwitchProvider>
      <UpdateToast />
    </div>
  );
}
