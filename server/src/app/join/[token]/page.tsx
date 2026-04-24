// /join/[token] — one-click world invite acceptance.
//
// Server component: if the user isn't logged in we redirect to /login
// with a `next` param so they land back here after authenticating.
// If the token is valid they're added to the world (or just switched
// into it if they're already a member) and redirected to the home page.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { acceptInvite } from '@/lib/groups';

export const dynamic = 'force-dynamic';

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<never> {
  const { token } = await params;

  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
  }

  const result = acceptInvite({
    token,
    userId: session.userId,
    sessionId: session.id,
  });

  if (!result.ok) {
    if (result.reason === 'expired') redirect('/?invite=expired');
    redirect('/?invite=invalid');
  }

  // Full reload so the app picks up the new current_group_id.
  redirect('/home');
}
