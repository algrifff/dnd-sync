import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { getInviteToken } from '@/lib/groups';
import { DEFAULT_PERSONALITY, listPersonalities } from '@/lib/ai/personalities';
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
    .query<
      {
        name: string;
        header_color: string | null;
        active_personality_id: string | null;
        icon_updated_at: number;
      },
      [string]
    >(
      `SELECT name, header_color, active_personality_id, icon_updated_at
         FROM groups WHERE id = ?`,
    )
    .get(session.currentGroupId);

  const worldName = group?.name ?? 'Unknown';
  const inviteToken = getInviteToken(session.currentGroupId);

  const personalities = listPersonalities(session.currentGroupId).map((p) => ({
    id: p.id,
    name: p.name,
    prompt: p.prompt,
  }));

  return (
    <ServerSettingsForm
      worldId={session.currentGroupId}
      worldName={worldName}
      headerColor={group?.header_color ?? null}
      iconVersion={group?.icon_updated_at ?? 0}
      csrfToken={session.csrfToken}
      initialToken={inviteToken}
      personalities={personalities}
      activePersonalityId={group?.active_personality_id ?? DEFAULT_PERSONALITY.id}
      builtinPersonality={{
        id: DEFAULT_PERSONALITY.id,
        name: DEFAULT_PERSONALITY.name,
        prompt: DEFAULT_PERSONALITY.prompt,
      }}
    />
  );
}
