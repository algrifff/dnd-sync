// Assets gallery. Shell owned by (content)/layout.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listGroupAssetsWithTags } from '@/lib/assets';
import { GM_MODE_COOKIE, treeModeFor } from '@/lib/gm-mode';
import { AssetsGallery } from '../../../assets/AssetsGallery';

export const dynamic = 'force-dynamic';

export default async function AssetsPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/assets');

  const mode = treeModeFor(jar.get(GM_MODE_COOKIE)?.value, session.role);
  const assets = listGroupAssetsWithTags(session.currentGroupId, { mode });

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-1 text-3xl font-bold" style={{ fontFamily: '"Fraunces", Georgia, serif' }}>
          Assets
        </h1>
        <p className="mb-6 text-sm text-[var(--ink-soft)]">
          Every image, map, and token in this world. Click a tile to open a full-size
          preview.
        </p>
        <AssetsGallery
          assets={assets}
          csrfToken={session.csrfToken}
          canEdit={session.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
