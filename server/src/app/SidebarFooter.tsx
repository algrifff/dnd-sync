// Bottom of the left sidebar: signed-in identity + sign-out.

import type { ReactElement } from 'react';
import { logoutAction } from './login/actions';

export function SidebarFooter({
  username,
}: {
  username: string;
}): ReactElement {
  return (
    <div className="shrink-0 border-r border-t border-[var(--rule)] bg-[var(--parchment-sunk)]/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-[var(--ink-soft)]">@{username}</span>
        <form action={logoutAction}>
          <button
            type="submit"
            className="rounded-[6px] border border-[var(--rule)] bg-[var(--vellum)] px-2 py-1 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--parchment)] hover:text-[var(--ink)]"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
