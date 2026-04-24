import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { ACCENT_PALETTE } from '@/lib/users';
import { ProfileForm } from '@/app/settings/profile/ProfileForm';
import { PasswordForm } from '@/app/settings/profile/PasswordForm';

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
      <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
        <h2 className="mb-1 text-lg font-semibold">Profile</h2>
        <p className="mb-4 text-sm text-[var(--ink-soft)]">
          Your display name is what peers see next to your cursor and in the presence panel.
        </p>
        <ProfileForm
          userId={session.userId}
          initialDisplayName={session.displayName}
          initialAccentColor={session.accentColor}
          initialCursorMode={session.cursorMode}
          initialAvatarVersion={session.avatarVersion}
          initialTheme={session.theme}
          username={session.username}
          csrfToken={session.csrfToken}
          palette={[...ACCENT_PALETTE]}
        />
      </section>

      <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
        <h2 className="mb-1 text-lg font-semibold">Password</h2>
        <p className="mb-4 text-sm text-[var(--ink-soft)]">
          Minimum 8 characters. The current password is required - a stolen session alone
          shouldn&rsquo;t be enough to change it.
        </p>
        <PasswordForm csrfToken={session.csrfToken} />
      </section>
    </div>
  );
}
