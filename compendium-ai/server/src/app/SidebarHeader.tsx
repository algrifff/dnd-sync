// Top of the left sidebar: compact nav + brand affordance. Nav links
// live here (not in the main-pane header) so the tab strip above the
// note has room and the sidebar reads as a single self-contained
// column.

import type { ReactElement } from 'react';
import Link from 'next/link';
import { Home, Tag } from 'lucide-react';
import { SettingsMenu } from './SettingsMenu';

export function SidebarHeader({
  role,
}: {
  role: 'admin' | 'editor' | 'viewer';
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-[#D4C7AE] bg-[#EAE1CF]/80 px-2 py-1.5">
      <IconLink href="/" label="Home" icon={<Home size={14} aria-hidden />} />
      <IconLink href="/tags" label="Tags" icon={<Tag size={14} aria-hidden />} />
      <div className="flex-1" />
      {role === 'admin' && <SettingsMenu />}
    </div>
  );
}

function IconLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
}): ReactElement {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className="flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E]"
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
