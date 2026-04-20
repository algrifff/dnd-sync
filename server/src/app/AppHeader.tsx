// Full-width top bar spanning the entire viewport.
// Left: world name (coloured). Centre: global search. Right: presence
// avatars + world-settings shortcut (admin only).
// Note tabs live in NoteTabBar, rendered below this inside the content column.

import type { ReactElement } from 'react';
import Link from 'next/link';
import { Settings2 } from 'lucide-react';
import { PresenceClient, type Me } from './PresenceClient';
import { WorldSearchBar } from './WorldSearchBar';
import { getWorldHeader } from '@/lib/groups';
import { logoutAction } from './login/actions';

export function AppHeader({
  role,
  me,
  user,
  csrfToken: _csrfToken,
  canCreate: _canCreate,
  groupId,
}: {
  role: 'admin' | 'editor' | 'viewer';
  me: Me;
  user?: { displayName: string; username: string; accentColor: string };
  csrfToken?: string;
  canCreate?: boolean;
  groupId?: string;
}): ReactElement {
  const worldHeader = groupId ? getWorldHeader(groupId) : null;
  const worldName = worldHeader?.name ?? '';
  const headerColor = worldHeader?.headerColor ?? '#2A241E';

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#D4C7AE] bg-[#EAE1CF] px-4">
      {/* World name — far left */}
      {worldName && (
        <span
          className="shrink-0 text-sm font-bold tracking-tight"
          style={{ color: headerColor }}
        >
          {worldName}
        </span>
      )}

      {/* Search — fills centre */}
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

      {/* World settings — far right, admin only */}
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
    </header>
  );
}
