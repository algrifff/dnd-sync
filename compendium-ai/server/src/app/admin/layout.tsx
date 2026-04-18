// Admin-only shell. Middleware already requires a session to reach any
// /admin route; this layout adds the role check. Non-admins hit a 403
// page rather than a silent redirect so we don't leak whether the URL
// exists.

import type { ReactElement, ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);

  if (!session) redirect('/login?next=/admin');
  if (session.role !== 'admin') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#F4EDE0] px-4">
        <div className="max-w-md rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-6 text-center">
          <h1
            className="mb-2 text-2xl font-semibold text-[#2A241E]"
            style={{ fontFamily: '"Fraunces", Georgia, serif' }}
          >
            Forbidden
          </h1>
          <p className="text-sm text-[#5A4F42]">
            Your account doesn&rsquo;t have admin permissions. Ask the DM.
          </p>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
