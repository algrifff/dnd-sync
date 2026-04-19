// Bottom of the left sidebar: user chip + sign-out. Kept out of the top
// bar so the tab strip has room to breathe and the "who am I" affordance
// is always reachable without being in the way.

import type { ReactElement } from 'react';
import Link from 'next/link';
import { Settings } from 'lucide-react';
import { logoutAction } from './login/actions';

export function SidebarFooter({
  displayName,
  username,
  role,
  accentColor,
}: {
  displayName: string;
  username: string;
  role: 'admin' | 'editor' | 'viewer';
  accentColor: string;
}): ReactElement {
  return (
    <div className="shrink-0 border-t border-[#D4C7AE] bg-[#EAE1CF]/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: accentColor }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-[#2A241E]">
              {displayName}
            </span>
            {role === 'admin' && (
              <span className="rounded-full border border-[#D4A85A]/50 bg-[#D4A85A]/15 px-1.5 text-[10px] font-medium uppercase tracking-wide text-[#5A4F42]">
                admin
              </span>
            )}
          </div>
          <div className="truncate text-xs text-[#5A4F42]">@{username}</div>
        </div>
        <Link
          href="/settings/profile"
          title="Settings"
          aria-label="Settings"
          className="rounded-[6px] p-1.5 text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E]"
        >
          <Settings size={14} aria-hidden />
        </Link>
        <form action={logoutAction}>
          <button
            type="submit"
            className="rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] px-2 py-1 text-xs text-[#5A4F42] transition hover:bg-[#F4EDE0] hover:text-[#2A241E]"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
