// /settings/profile — display name, accent colour, password. Available
// to every authed user.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { ACCENT_PALETTE } from '@/lib/users';
import { ProfileForm } from './ProfileForm';
import { PasswordForm } from './PasswordForm';

export const dynamic = 'force-dynamic';

export default async function ProfilePage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/settings/profile');

  return (
    <div className="space-y-6">
      <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
        <h2 className="mb-1 text-lg font-semibold">Profile</h2>
        <p className="mb-4 text-sm text-[#5A4F42]">
          Your display name is what peers see next to your cursor and in the
          presence panel.
        </p>
        <ProfileForm
          initialDisplayName={session.displayName}
          initialAccentColor={session.accentColor}
          username={session.username}
          csrfToken={session.csrfToken}
          palette={[...ACCENT_PALETTE]}
        />
      </section>

      <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
        <h2 className="mb-1 text-lg font-semibold">Password</h2>
        <p className="mb-4 text-sm text-[#5A4F42]">
          Minimum 8 characters. The current password is required — a stolen
          session alone shouldn&rsquo;t be enough to change it.
        </p>
        <PasswordForm csrfToken={session.csrfToken} />
      </section>
    </div>
  );
}
