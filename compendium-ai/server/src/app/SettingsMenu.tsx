'use client';

// Admin-only dropdown. Keeps operator surfaces (vault upload, user
// management) out of the day-to-day nav. The gear icon lives in the
// sidebar header + the includeNav fallback header.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Settings, Archive, Users } from 'lucide-react';

export function SettingsMenu(): React.JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Admin settings"
        aria-label="Admin settings"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E]"
      >
        <Settings size={14} aria-hidden />
        <span>Settings</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-[8px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_8px_24px_rgba(42,36,30,0.18)]"
        >
          <MenuLink
            href="/admin/vault"
            icon={<Archive size={13} aria-hidden />}
            onClick={() => setOpen(false)}
          >
            Vault
          </MenuLink>
          <MenuLink
            href="/admin/users"
            icon={<Users size={13} aria-hidden />}
            onClick={() => setOpen(false)}
          >
            Users
          </MenuLink>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  icon,
  onClick,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 text-xs text-[#2A241E] transition hover:bg-[#D4A85A]/15"
    >
      {icon}
      <span>{children}</span>
    </Link>
  );
}
