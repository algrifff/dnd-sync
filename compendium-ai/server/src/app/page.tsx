// Home route. Server component: reads the session cookie, renders a
// session-aware header with logout, then mounts the existing admin
// dashboard beneath. Middleware has already gated access (no session →
// /login), so a session is expected by the time we render. If for any
// reason it isn't, fall back to a redirect rather than a crash.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import Dashboard from './Dashboard';
import { SessionHeader } from './SessionHeader';

export const dynamic = 'force-dynamic';

export default async function HomePage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/');

  return (
    <div className="min-h-screen bg-[#F4EDE0] text-[#2A241E]">
      <SessionHeader
        displayName={session.displayName}
        username={session.username}
        role={session.role}
        accentColor={session.accentColor}
      />
      <Dashboard />
    </div>
  );
}
