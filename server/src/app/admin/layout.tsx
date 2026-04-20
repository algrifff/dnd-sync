// Minimal shell for /admin/* — super-admin dashboard, accessible only
// with the ADMIN_TOKEN bearer credential (cookie __sa, set at /admin/login).
// No player sidebar or world context — this is server-wide, not per-world.

import type { ReactElement, ReactNode } from 'react';
import { Shield } from 'lucide-react';
import { AdminSignOut } from './AdminSignOut';

export const dynamic = 'force-dynamic';

export default function AdminLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <div className="min-h-screen bg-[#F4EDE0] text-[#2A241E]">
      <header className="flex items-center justify-between border-b border-[#D4C7AE] bg-[#FBF5E8] px-6 py-3">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-[#5A4F42]" aria-hidden />
          <span
            className="text-base font-semibold text-[#2A241E]"
            style={{ fontFamily: '"Fraunces", Georgia, serif' }}
          >
            Compendium Admin
          </span>
        </div>
        <AdminSignOut />
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        <h1
          className="mb-1 text-3xl font-bold"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Users
        </h1>
        <p className="mb-6 text-sm text-[#5A4F42]">
          Create accounts and manage who can access this server.
        </p>
        {children}
      </main>
    </div>
  );
}
