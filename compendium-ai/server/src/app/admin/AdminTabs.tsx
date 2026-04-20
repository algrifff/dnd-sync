'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Tab = { href: string; label: string };

const TABS: Tab[] = [
  { href: '/admin/vault', label: 'Vault' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/templates', label: 'Templates' },
  { href: '/admin/server', label: 'Server' },
];

export function AdminTabs(): React.JSX.Element {
  const pathname = usePathname() ?? '';

  return (
    <div
      role="tablist"
      aria-label="DM Panel"
      className="flex items-end gap-0.5 border-b border-[#D4C7AE]"
    >
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + '/');
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
