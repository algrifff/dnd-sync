'use client';

// Two distinct tab sets share the /settings/* layout: profile settings
// (visible to everyone) and world admin settings (admins only). The
// active set is determined by the current path — profile paths get the
// Profile tab, world-admin paths get World / Members / Templates / Vault.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Tab = { href: string; label: string };

const WORLD_PATHS = [
  '/settings/world',
  '/settings/members',
  '/settings/templates',
  '/settings/vault',
] as const;

const PROFILE_TABS: Tab[] = [{ href: '/settings/profile', label: 'Profile' }];

const WORLD_TABS: Tab[] = [
  { href: '/settings/world', label: 'World' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/templates', label: 'Templates' },
  { href: '/settings/vault', label: 'Import Notes' },
];

export function SettingsTabs(): React.JSX.Element | null {
  const pathname = usePathname() ?? '';
  const isWorld = WORLD_PATHS.some((p) => pathname.startsWith(p));
  const tabs = isWorld ? WORLD_TABS : PROFILE_TABS;

  return (
    <div
      role="tablist"
      aria-label={isWorld ? 'World settings' : 'Profile settings'}
      className="flex items-end gap-0.5 border-b border-[var(--rule)]"
    >
      {tabs.map((t) => {
        const active =
          pathname === t.href || pathname.startsWith(t.href + '/');
        return (
          <Link
            key={t.href}
            role="tab"
            aria-selected={active}
            href={t.href}
            className={
              'relative -mb-px rounded-t-[8px] px-4 py-1.5 text-sm transition ' +
              (active
                ? 'z-10 border border-b-0 border-[var(--rule)] bg-[var(--parchment)] font-medium text-[var(--ink)]'
                : 'border border-transparent text-[var(--ink-soft)] hover:bg-[var(--vellum)]/70 hover:text-[var(--ink)]')
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
