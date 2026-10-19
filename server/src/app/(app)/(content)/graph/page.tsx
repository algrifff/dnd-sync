// The Orrery: the graph page. Shell (header, sidebar, tab bar) comes
// from the parent (content)/layout. The original Sigma view lives at
// /graph/classic.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getWorldHeader } from '@/lib/groups';
import { listVisibleCampaignNames } from '@/lib/graph';
import { visibilityFor } from '@/lib/notes';
import { GM_MODE_COOKIE, treeModeFor } from '@/lib/gm-mode';
// Lazy-loaded (ssr:false), see OrreryLoader.tsx.
import { OrreryCanvas } from './OrreryLoader';

export const dynamic = 'force-dynamic';

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string | string[] }>;
}): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  const { focus } = await searchParams;
  const focusPath = typeof focus === 'string' && focus ? focus : null;
  if (!session) {
    const next = focusPath ? `/graph?focus=${encodeURIComponent(focusPath)}` : '/graph';
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const campNames = listVisibleCampaignNames(session.currentGroupId, {
    mode: treeModeFor(jar.get(GM_MODE_COOKIE)?.value, session.role),
    vis: visibilityFor(session.role),
  });

  return (
    <div className="relative flex-1 overflow-hidden">
      <OrreryCanvas
        worldName={getWorldHeader(session.currentGroupId).name}
        campNames={campNames}
        initialFocus={focusPath}
      />
    </div>
  );
}
