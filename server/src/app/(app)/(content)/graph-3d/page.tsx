// 3D star-field variant of the mind-map. Prototype — coexists with /graph.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { GraphCanvas3D } from '../../../graph/GraphCanvas3D';

export const dynamic = 'force-dynamic';

export default async function Graph3DPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/graph-3d');

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <GraphCanvas3D groupId={session.currentGroupId} />
    </div>
  );
}
