// /me/characters/[id] — editor for a user-level character. Lightweight
// form (name, portrait URL, key sheet fields) that PATCHes
// /api/me/characters/[id]. Full SheetHeader parity will come once
// two-way sync with bound campaign notes is wired up.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getUserCharacter } from '@/lib/userCharacters';
import { getTemplate } from '@/lib/templates';
import { UserCharacterEditor } from './UserCharacterEditor';

export const dynamic = 'force-dynamic';

export default async function UserCharacterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/me');
  const { id } = await params;
  const character = getUserCharacter(id, session.userId);
  if (!character) notFound();

  const template = getTemplate(character.kind) ?? getTemplate('character');
  const sections = template?.schema.sections ?? [];

  return (
    <UserCharacterEditor
      csrfToken={session.csrfToken}
      character={character}
      sections={sections}
    />
  );
}
