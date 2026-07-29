// Graph/mind-map view. Shell (header, sidebar, tab bar) comes from
// the parent (content)/layout; this page just renders the canvas.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listAllTags } from '@/lib/notes';
// Lazy-loaded (ssr:false) — see GraphCanvasLoader.tsx for why this is a
// separate Client Component file rather than a plain import, and for
// the measured bundle-size before/after.
import { GraphCanvas } from './GraphCanvasLoader';

export const dynamic = 'force-dynamic';

export default async function GraphPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/graph');

  const allTags = listAllTags(session.currentGroupId).map((t) => t.tag);

  return (
    <div className="relative flex-1 overflow-hidden">
      <GraphCanvas
        groupId={session.currentGroupId}
        allTags={allTags}
        csrfToken={session.csrfToken}
        me={{
          userId: session.userId,
          displayName: session.displayName,
          accentColor: session.accentColor,
          cursorMode: session.cursorMode,
          avatarVersion: session.avatarVersion,
        }}
      />
    </div>
  );
}
