'use client';

// Settings subnav. The current tab is derived from the URL via
// usePathname so server-rendered children stay in sync without any
// extra prop plumbing. Admin-only tabs are hidden from everyone else.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Tab = { href: string; label: string };

export function SettingsTabs({
  role,
}: {
  role: 'admin' | 'editor' | 'viewer';
}): React.JSX.Element {
  const pathname = usePathname() ?? '';
  const tabs: Tab[] = [{ href: '/settings/profile', label: 'Profile' }];
  if (role === 'admin') {
    tabs.push({ href: '/settings/vault', label: 'Vault' });
    tabs.push({ href: '/settings/users', label: 'Users' });
  }

  return (
    <div
      role="tablist"
      aria-label="Settings"
      className="flex items-end gap-0.5 border-b border-[#D4C7AE]"
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
                ? 'z-10 border border-b-0 border-[#D4C7AE] bg-[#F4EDE0] font-medium text-[#2A241E]'
                : 'border border-transparent text-[#5A4F42] hover:bg-[#FBF5E8]/70 hover:text-[#2A241E]')
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
