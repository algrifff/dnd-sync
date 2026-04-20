// Two-row top bar.
// Row 1 — identity bar: world name (coloured), global search, live presence
//          avatars, and (admin-only) world settings shortcut.
// Row 2 — tab strip: open-note tabs + new-tab button.

import type { ReactElement } from 'react';
import Link from 'next/link';
import { Settings2 } from 'lucide-react';
import { NoteTabs } from './NoteTabs';
import { NewTabButton } from './NewTabButton';
import { PresenceClient, type Me } from './PresenceClient';
import { WorldSearchBar } from './WorldSearchBar';
import { getWorldHeader } from '@/lib/groups';
import { logoutAction } from './login/actions';

export function AppHeader({
  role,
  me,
  user,
  csrfToken,
  canCreate,
  includeNav = false,
  groupId,
}: {
  role: 'admin' | 'editor' | 'viewer';
  me: Me;
  user?: { displayName: string; username: string; accentColor: string };
  csrfToken?: string;
  canCreate?: boolean;
  includeNav?: boolean;
  groupId?: string;
}): ReactElement {
  const worldHeader = groupId ? getWorldHeader(groupId) : null;
  const worldName = worldHeader?.name ?? '';
  const headerColor = worldHeader?.headerColor ?? '#2A241E';

  return (
    <header className="shrink-0 border-b border-[#D4C7AE] bg-[#EAE1CF]">
      {/* Row 1 — identity */}
      <div className="flex h-10 items-center gap-3 px-3">
        {includeNav && (
          <nav className="flex shrink-0 items-center gap-3 pr-2 text-sm text-[#5A4F42]">
            <Link href="/" className="underline-offset-2 hover:underline">Home</Link>
            <Link href="/tags" className="underline-offset-2 hover:underline">Tags</Link>
            <span aria-hidden className="h-5 w-px bg-[#D4C7AE]" />
          </nav>
        )}

        {/* World name */}
        {worldName && (
          <span
            className="shrink-0 text-sm font-bold tracking-tight"
            style={{ color: headerColor }}
          >
            {worldName}
          </span>
        )}

        {/* Search — fills remaining space */}
        <WorldSearchBar />

        {/* Presence avatars */}
        <PresenceClient me={me} />

        {/* User chip (sidebar-less pages only) */}
        {user && (
          <div className="flex shrink-0 items-center gap-2 pl-1">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: user.accentColor }}
            />
            <span className="text-xs text-[#2A241E]">
              <span className="font-medium">{user.displayName}</span>{' '}
              <span className="text-[#5A4F42]">({user.username})</span>
            </span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] px-2 py-1 text-xs text-[#5A4F42] transition hover:bg-[#F4EDE0] hover:text-[#2A241E]"
              >
                Sign out
              </button>
            </form>
          </div>
        )}

        {/* World settings shortcut — admin only, far right */}
        {role === 'admin' && groupId && (
          <Link
            href="/settings/world"
            title="World settings"
            aria-label="World settings"
            className="shrink-0 flex h-7 w-7 items-center justify-center rounded-[6px] text-[#5A4F42] transition hover:bg-[#D4A85A]/20 hover:text-[#2A241E]"
          >
            <Settings2 size={15} aria-hidden />
          </Link>
        )}
      </div>

      {/* Row 2 — tabs */}
      <div className="flex h-9 items-end gap-1 pl-2 pr-3">
        <NoteTabs />
        {canCreate && csrfToken && <NewTabButton csrfToken={csrfToken} />}
      </div>
    </header>
  );
}
