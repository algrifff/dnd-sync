// Top of the left sidebar: compact icon-only nav. The sidebar is
// narrow (260 px) and labels ate all of it; native tooltips on each
// icon cover the discoverability side without stealing horizontal
// space from content.

import type { ReactElement } from 'react';
import Link from 'next/link';
import {
  Home,
  Tag,
  Share2,
  Image as ImageIcon,
  PenTool,
} from 'lucide-react';

export function SidebarHeader({
  role: _role,
  features,
}: {
  role: 'admin' | 'editor' | 'viewer';
  features?: { excalidraw?: boolean };
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center justify-center gap-0.5 border-b border-r border-[var(--rule)] px-2 py-1.5">
      <IconLink href="/home" label="Home" icon={<Home size={16} aria-hidden />} />
      <IconLink href="/tags" label="Tags" icon={<Tag size={16} aria-hidden />} />
      <IconLink href="/graph" label="Graph" icon={<Share2 size={16} aria-hidden />} />
      <IconLink href="/assets" label="Assets" icon={<ImageIcon size={16} aria-hidden />} />
      {features?.excalidraw && (
        <IconLink href="/excalidraw" label="Excalidraw" icon={<PenTool size={16} aria-hidden />} />
      )}
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
      className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/20 hover:text-[var(--ink)]"
    >
      {icon}
    </Link>
  );
}
