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
    <div className="min-h-screen bg-[var(--parchment)] text-[var(--ink)]">
      <header className="flex items-center justify-between border-b border-[var(--rule)] bg-[var(--vellum)] px-6 py-3">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-[var(--ink-soft)]" aria-hidden />
          <span
            className="text-base font-semibold text-[var(--ink)]"
            style={{ fontFamily: '"Fraunces", Georgia, serif' }}
          >
            Compendium Admin
          </span>
        </div>
        <AdminSignOut />
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        {children}
      </main>
    </div>
  );
}
