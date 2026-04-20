import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { getInviteToken } from '@/lib/groups';
import { ServerSettingsForm } from '@/app/admin/server/ServerSettingsForm';

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

  const group = getDb()
    .query<{ name: string; header_color: string | null }, [string]>(
      'SELECT name, header_color FROM groups WHERE id = ?',
    )
    .get(session.currentGroupId);

  const worldName = group?.name ?? 'Unknown';
  const inviteToken = getInviteToken(session.currentGroupId);

  return (
    <ServerSettingsForm
      worldId={session.currentGroupId}
      worldName={worldName}
      headerColor={group?.header_color ?? null}
      csrfToken={session.csrfToken}
      initialToken={inviteToken}
    />
  );
}
