// Thin top bar above the main content pane. Hosts the tab strip and a
// "+" affordance that spawns a new blank note. Nav (Home/Tags/...) has
// moved to SidebarHeader; pages that render without a sidebar ask for
// `includeNav` and get a compact inline nav here instead.

import type { ReactElement } from 'react';
import Link from 'next/link';
import { NoteTabs } from './NoteTabs';
import { NewTabButton } from './NewTabButton';
import { logoutAction } from './login/actions';

export function AppHeader({
  role,
  user,
  csrfToken,
  canCreate,
  includeNav = false,
}: {
  role: 'admin' | 'editor' | 'viewer';
  user?: { displayName: string; username: string; accentColor: string };
  csrfToken?: string;
  canCreate?: boolean;
  includeNav?: boolean;
}): ReactElement {
  return (
    <header className="flex min-h-[38px] items-end gap-1 border-b border-[#D4C7AE] bg-[#EAE1CF]/60 pl-2 pr-3 pt-1.5">
      {includeNav && (
        <nav className="mb-1.5 flex shrink-0 items-center gap-3 pr-3 text-sm text-[#5A4F42]">
          <Link href="/" className="underline-offset-2 hover:underline">
            Home
          </Link>
          <Link href="/tags" className="underline-offset-2 hover:underline">
            Tags
          </Link>
          {role === 'admin' && (
            <>
              <Link href="/admin/vault" className="underline-offset-2 hover:underline">
                Vault
              </Link>
              <Link href="/admin/users" className="underline-offset-2 hover:underline">
                Users
              </Link>
            </>
          )}
          <span aria-hidden className="h-5 w-px bg-[#D4C7AE]" />
        </nav>
      )}

      <NoteTabs />

      {canCreate && csrfToken && <NewTabButton csrfToken={csrfToken} />}

      {user && (
        <div className="mb-1.5 flex shrink-0 items-center gap-2 pl-3">
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
    </header>
  );
}
