import type { ReactElement } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { isGroupMember } from '@/lib/groups';
import { LandingClient } from './LandingClient';
import { ThemeToggle } from './ThemeToggle';
import { AuthShell } from './login/AuthShell';

export const dynamic = 'force-dynamic';

type InviteStatus = 'expired' | 'invalid';

function parseInviteStatus(raw: string | string[] | undefined): InviteStatus | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'expired' || value === 'invalid' ? value : null;
}

export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string | string[] }>;
}): Promise<ReactElement> {
  const { invite } = await searchParams;
  const inviteStatus = parseInviteStatus(invite);

  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader, false);
  if (session) {
    // Returning users with a valid active world land on that world's
    // /home. First logins (no currentGroupId) and users whose last
    // world was deleted or revoked fall through to /me, the personal
    // overview, where they can create a world or join one.
    const hasActiveWorld =
      !!session.currentGroupId && isGroupMember(session.userId, session.currentGroupId);
    const continueHref = hasActiveWorld ? '/home' : '/me';

    // /join/[token] requires a session before it resolves an invite, so
    // the overwhelming majority of invite clicks land here already
    // authenticated. Without this branch that redirect above fires
    // first and the ?invite=expired|invalid signal is lost forever —
    // surface it instead of silently bouncing them past it.
    if (inviteStatus) {
      return (
        <AuthShell
          title={
            inviteStatus === 'expired' ? 'That invite has expired' : "That invite link isn't valid"
          }
          subtitle={
            inviteStatus === 'expired'
              ? 'Ask whoever sent it for a fresh one — invite links only last so long.'
              : 'Double-check the link, or ask whoever sent it to send a new one.'
          }
        >
          <div className="text-center">
            <Link
              href={continueHref}
              className="inline-block rounded-[12px] bg-[var(--ink)] px-8 py-3 text-[15px] font-semibold text-[var(--parchment)] shadow-[0_2px_0_rgba(0,0,0,0.2)] transition hover:bg-[var(--wine)]"
              style={{ fontFamily: '"Fraunces", Georgia, serif' }}
            >
              Continue to your table
            </Link>
          </div>
        </AuthShell>
      );
    }

    redirect(continueHref);
  }
  return (
    <>
      <ThemeToggle />
      <LandingClient {...(inviteStatus ? { inviteStatus } : {})} />
    </>
  );
}
