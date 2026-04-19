// Top of the left sidebar: compact nav + brand affordance. Nav links
// live here (not in the main-pane header) so the tab strip above the
// note has room and the sidebar reads as a single self-contained
// column.

import type { ReactElement } from 'react';
import Link from 'next/link';
import {
  Home,
  Tag,
  Share2,
  UserRound,
  CalendarDays,
  Image as ImageIcon,
} from 'lucide-react';

export function SidebarHeader({
  role: _role,
}: {
  role: 'admin' | 'editor' | 'viewer';
}): ReactElement {
  return (
    <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-[#D4C7AE] bg-[#EAE1CF] px-2">
      <IconLink href="/" label="Home" icon={<Home size={14} aria-hidden />} />
      <IconLink href="/tags" label="Tags" icon={<Tag size={14} aria-hidden />} />
      <IconLink href="/graph" label="Graph" icon={<Share2 size={14} aria-hidden />} />
      <IconLink href="/characters" label="Cast" icon={<UserRound size={14} aria-hidden />} />
      <IconLink href="/sessions" label="Sessions" icon={<CalendarDays size={14} aria-hidden />} />
      <IconLink href="/assets" label="Assets" icon={<ImageIcon size={14} aria-hidden />} />
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
