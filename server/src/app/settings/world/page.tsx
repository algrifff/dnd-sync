import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { WorldNameForm } from './WorldNameForm';

export const dynamic = 'force-dynamic';

export default async function WorldSettingsPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/settings/world');
  if (session.role !== 'admin') redirect('/settings/profile');

  const row = getDb()
    .query<{ name: string }, [string]>('SELECT name FROM groups WHERE id = ?')
    .get(session.currentGroupId);

  const worldName = row?.name ?? '';

  return (
    <div className="space-y-6">
      <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
        <h2 className="mb-1 text-lg font-semibold">World name</h2>
        <p className="mb-4 text-sm text-[#5A4F42]">
          The name shown in the worlds rail and to all members of this world.
        </p>
        <WorldNameForm
          worldId={session.currentGroupId}
          initialName={worldName}
          csrfToken={session.csrfToken}
        />
      </section>
    </div>
  );
}
