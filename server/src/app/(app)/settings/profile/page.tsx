import type { ReactElement } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { ACCENT_PALETTE } from '@/lib/users';
import { listGrantsForUser } from '@/lib/oauth';
import { publicUrls } from '@/lib/public-url';
import { getWorldHeader } from '@/lib/groups';
import { ProfileForm } from '@/app/settings/profile/ProfileForm';
import { PasswordForm } from '@/app/settings/profile/PasswordForm';
import { ConnectedApps } from '@/app/settings/profile/ConnectedApps';
import { ConnectClaude } from '@/app/settings/profile/ConnectClaude';

export const dynamic = 'force-dynamic';

export default async function ProfilePage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/settings/profile');

  const mcpUrl = publicUrls(await headers()).mcpResource;
  const worldName = getWorldHeader(session.currentGroupId).name;

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

      <section id="connect-claude" className="scroll-mt-4 rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
        <h2 className="mb-1 text-lg font-semibold">Connect Claude</h2>
        <p className="mb-4 text-sm text-[var(--ink-soft)]">
          Let your own Claude (or Codex) read this World and draft Session Wrap-ups. It uses
          your own subscription and sees only the Notes you can see.
        </p>
        <ConnectClaude mcpUrl={mcpUrl} worldName={worldName} />
      </section>

      <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
        <h2 className="mb-1 text-lg font-semibold">Connected apps</h2>
        <p className="mb-4 text-sm text-[var(--ink-soft)]">
          Apps such as Claude that you have allowed to read one of your worlds. Disconnecting
          one signs it out everywhere; it will ask for access again next time.
        </p>
        <ConnectedApps apps={listGrantsForUser(session.userId)} csrfToken={session.csrfToken} />
      </section>
    </div>
  );
}
