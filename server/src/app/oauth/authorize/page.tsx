// GET /oauth/authorize — the OAuth consent screen. Middleware already
// bounced anonymous visitors to /login?next=<this URL with its query>,
// so by the time this renders there is a session. The page validates
// the request, names the client and where it will be sent back to, and
// lets the user pick which world to share. The decision itself is
// posted by ConsentForm to /api/oauth/authorize.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listWorldsForSession } from '@/lib/groups';
import { checkAuthorizeRequest, isKnownClaudeRedirect } from '@/lib/oauth-authorize';
import { publicUrls } from '@/lib/public-url';
import { AuthShell } from '@/app/login/AuthShell';
import { ConsentForm } from './ConsentForm';

export const dynamic = 'force-dynamic';

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string') query[k] = v;

  const jar = await cookies();
  const cookieHeader = jar.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  const session = readSession(cookieHeader, false);
  if (!session) {
    const self = '/oauth/authorize?' + new URLSearchParams(query as Record<string, string>).toString();
    redirect(`/login?next=${encodeURIComponent(self)}`);
  }

  const urls = publicUrls(await headers());
  const check = await checkAuthorizeRequest(query, urls.mcpResource);
  if (!check.ok && !check.redirectable) {
    return (
      <AuthShell title="That request can’t be completed" subtitle={check.description}>
        <p className="text-center text-sm text-[var(--ink-soft)]">
          Close this tab and try connecting again from Claude.
        </p>
      </AuthShell>
    );
  }

  const clientName = check.ok ? check.client.clientName : 'this app';
  const redirectHost = new URL(check.query.redirect_uri).host;
  const worlds = listWorldsForSession(session.userId, session.id).map((w) => ({
    id: w.id,
    name: w.name,
    role: w.role,
    isActive: w.isActive,
  }));

  return (
    <AuthShell
      title={`Let ${clientName} (redirects to ${redirectHost}) read your notes?`}
      subtitle={`Signed in as ${session.displayName}. ${clientName} will be able to list, search and read the notes you can see in one world. It cannot change anything.`}
    >
      <ConsentForm
        csrfToken={session.csrfToken}
        query={query as Record<string, string>}
        clientName={clientName}
        redirectHost={redirectHost}
        verified={isKnownClaudeRedirect(check.query.redirect_uri)}
        worlds={worlds}
        invalid={check.ok ? null : check.description}
      />
    </AuthShell>
  );
}
