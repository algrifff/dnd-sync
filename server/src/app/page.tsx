import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
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
  if (session) redirect('/home');
  return (
    <>
      <ThemeToggle />
      <LandingClient />
    </>
  );
}
